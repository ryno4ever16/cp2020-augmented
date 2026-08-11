/** ACPA Unit A — PA-skill compendium backfill on pilot-link (the integration PARKED in the identity
 *  keeper; needs the supplement-skills pack recompiled with the 3 PA skills + a rig restart, both done).
 *  Proves: the pack carries the 3 PA skills; backfillPaSkills pulls them from the compendium onto a pilot
 *  (keepId → stable _ids); it is idempotent; and the live updateActor hook backfills on pilot-link.
 *  Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-pa-skills-backfill.mjs */
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
  const ok = (k, v) => { out.checks[k] = v; };
  const IDS = ["PACombatSense001", "PATechSkill00001", "ExpertPADesign01"];
  const hasAll = (actor) => IDS.every(id => actor.items.some(i => i._id === id && i.type === "skill"));
  const countPA = (actor) => actor.items.filter(i => IDS.includes(i._id) && i.type === "skill").length;

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__PABack"))) await a.delete().catch(()=>{});
  try { await game.settings.set("cp2020-augmented", "mechDocumentAutomation", true); } catch {}

  // (1) The recompiled pack carries all 3 PA skills.
  const pack = game.packs.get("cp2020-augmented.supplement-skills");
  out.packName = pack?.metadata?.label ?? null;
  const packDocs = pack ? await Promise.all(IDS.map(id => pack.getDocument(id).catch(() => null))) : [];
  out.packDocs = packDocs.map(d => d ? { id: d._id, name: d.name, type: d.type } : null);
  ok("pack_has_3", packDocs.length === 3 && packDocs.every(d => d && d.type === "skill"));
  ok("pack_pacs_named", packDocs[0]?.name === "PA Combat Sense");

  const M = await import("/modules/cp2020-augmented/module/mech/pa-skills.js");

  // (2) DIRECT backfill onto a fresh pilot — pulls the 3 skills from the compendium with stable _ids.
  const pilot = await Actor.create({ name: "__PW__PABack Direct", type: "character" });
  await new Promise(res => setTimeout(res, 300));         // let the base skill auto-seed settle
  const beforeHad = hasAll(game.actors.get(pilot.id));
  await M.backfillPaSkills(game.actors.get(pilot.id));
  const p1 = game.actors.get(pilot.id);
  ok("direct_added_3", !beforeHad && hasAll(p1) && countPA(p1) === 3);
  // keepId preserved the compendium _ids (so isPACombatSenseSkill matches by _id later).
  const U = await import("/modules/cp2020-augmented/module/utils.js");
  const paItem = p1.items.find(i => i._id === "PACombatSense001");
  ok("direct_pacs_matches_id", !!paItem && U.isPACombatSenseSkill(paItem) === true);

  // (3) Idempotent — a second backfill adds nothing.
  await M.backfillPaSkills(game.actors.get(pilot.id));
  ok("idempotent_still_3", countPA(game.actors.get(pilot.id)) === 3);

  // (4) LIVE HOOK — linking a pilot to an ACPA suit backfills the pilot's PA skills.
  const pilot2 = await Actor.create({ name: "__PW__PABack Hook", type: "character" });
  await new Promise(res => setTimeout(res, 300));
  const suit = await Actor.create({ name: "__PW__PABack Suit", type: "cp2020-augmented.vehicle",
    system: { isACPA: true, str: 25 } });
  const hookBefore = hasAll(game.actors.get(pilot2.id));
  await suit.update({ "system.pilotId": pilot2.id });      // fires updateActor → registerPaSkillBackfill
  // fire-and-forget backfill is async; poll the pilot up to ~3s for the 3 skills
  let hookAdded = false;
  for (let i = 0; i < 15; i++) { await new Promise(res => setTimeout(res, 200)); if (hasAll(game.actors.get(pilot2.id))) { hookAdded = true; break; } }
  ok("hook_backfilled_on_link", !hookBefore && hookAdded && countPA(game.actors.get(pilot2.id)) === 3);

  // cleanup
  await suit.delete().catch(()=>{});
  await pilot.delete().catch(()=>{});
  await pilot2.delete().catch(()=>{});
  return out;
});

console.log("\n===== ACPA Unit A — PA-skill compendium backfill =====");
console.log("  pack:", r.packName, "| docs:", JSON.stringify(r.packDocs));
for (const [k, v] of Object.entries(r.checks)) console.log(`  ${v ? "✅" : "❌"} ${k}`);
console.log("  page errors:", errors.length ? errors.slice(0, 5) : "none");
const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
const pass = failed.length === 0 && errors.length === 0;
console.log("\n  RESULT: " + (pass ? `PASS ✅ — ${Object.keys(r.checks).length}/${Object.keys(r.checks).length} checks`
  : `FAIL ❌ — ${failed.join(", ") || "(none)"}${errors.length ? " · errors: " + errors.length : ""}`));
await b.close();
process.exit(pass ? 0 : 1);
