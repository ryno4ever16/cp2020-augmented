/** ACPA Unit A — PA skills identity + no-collision (Maximum Metal p.52 PA Combat Sense).
 *  Proves: the module loads clean with the new pa-skills engine; isPACombatSenseSkill matches PA
 *  Combat Sense by _id AND by compendium sourceId; and it does NOT collide with the base Combat Sense
 *  (isCombatSenseSkill), so a pilot's own Combat Sense mod can't be corrupted by adding PA Combat Sense.
 *  The full pilot-link → compendium-backfill integration is PARKED for the Unit F battery (needs the
 *  supplement-skills pack recompiled with the 3 new skills + a rig restart). Runs on :30004. */
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
  const out = { checks: {} };
  const U = await import("/modules/cp2020-augmented/module/utils.js");
  const { isPACombatSenseSkill, isCombatSenseSkill } = U;
  out.exportsPresent = typeof isPACombatSenseSkill === "function" && typeof isCombatSenseSkill === "function";

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__PASkill"))) await a.delete().catch(()=>{});
  const actor = await Actor.create({ name: "__PW__PASkillPilot", type: "character" });

  // Base Combat Sense — create with its real _id (skip if the character already seeded it).
  const CS_ID = "BjBZ8zc7wh52MSwK";
  let combatSense = actor.items.find(i => i._id === CS_ID);
  if (!combatSense) {
    await actor.createEmbeddedDocuments("Item",
      [{ _id: CS_ID, name: "Combat Sense", type: "skill", system: { level: 5, stat: "ref" } }],
      { keepId: true });
    combatSense = actor.items.get(CS_ID);
  }

  // PA Combat Sense — the module compendium _id, created with keepId (mirrors the backfill's keepId:true).
  const PA_ID = "PACombatSense001";
  await actor.createEmbeddedDocuments("Item",
    [{ _id: PA_ID, name: "PA Combat Sense", type: "skill", system: { level: 3, stat: "ref" } }],
    { keepId: true });
  const paById = actor.items.get(PA_ID);

  // PA Combat Sense via a compendium sourceId (a drag-imported copy keeps sourceId, not the id).
  const created = await actor.createEmbeddedDocuments("Item",
    [{ name: "PA Combat Sense (imported)", type: "skill", system: { level: 2, stat: "ref" },
       flags: { core: { sourceId: "Compendium.cp2020-augmented.supplement-skills.Item.PACombatSense001" } } }]);
  const paBySource = actor.items.get(created[0].id);

  out.checks = {
    // PA Combat Sense IS matched (by _id, and by sourceId) — the created skill from a keepId backfill matches.
    paById_isPA:        isPACombatSenseSkill(paById) === true,
    paBySource_isPA:    isPACombatSenseSkill(paBySource) === true,
    // ...and is NOT mistaken for the base Combat Sense.
    paById_notCombat:   isCombatSenseSkill(paById) === false,
    // The base Combat Sense IS matched as Combat Sense and NOT as PA (the no-collision proof).
    combatSense_isCombat:  isCombatSenseSkill(combatSense) === true,
    combatSense_notPA:     isPACombatSenseSkill(combatSense) === false,
    // Both coexist on the same actor, distinctly.
    bothCoexist: !!combatSense && !!paById && combatSense._id !== paById._id,
  };
  await actor.delete().catch(()=>{});
  return out;
});

console.log("exportsPresent:", r.exportsPresent);
console.log("checks:", JSON.stringify(r.checks, null, 2));
const allPass = r.exportsPresent && Object.values(r.checks).every(v => v === true);
console.log("console/page errors:", errors.length ? errors.slice(0,8) : "none");
console.log(`RESULT: ${allPass && errors.length === 0 ? "PASS" : "FAIL"} (${Object.values(r.checks).filter(v=>v===true).length}/${Object.keys(r.checks).length} checks)`);
console.log("NOTE: pilot-link → compendium-backfill integration PARKED for Unit F (needs supplement-skills recompile + rig restart).");
await b.close();
