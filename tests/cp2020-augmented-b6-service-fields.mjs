/** B6: service-mode/period now persist in module flags (base `misc` DataModel strips system.*). */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await joinGM(p);

const r = await p.evaluate(async () => {
  const svc = await import("/modules/cp2020-augmented/module/shop/services.js");
  for (const a of game.actors.filter(a=>a.name==="__PW__B6")) await a.delete().catch(()=>{});
  const actor = await Actor.create({ name:"__PW__B6", type:"character" });
  const [item] = await actor.createEmbeddedDocuments("Item", [{ name:"__PW__Apartment", type:"misc" }]);

  // (1) form-equivalent write to the flag paths the template now binds → must persist + be read back
  await item.update({ "flags.cp2020-augmented.serviceMode": "recurring", "flags.cp2020-augmented.servicePeriod": "week" });
  const live = actor.items.get(item.id);
  const persisted = { mode: svc.serviceModeOf(live), period: svc.servicePeriodOf(live), classified: svc.classifyService(live) };

  // (2) control: the OLD system.* write is stripped by the base misc DataModel (why the old bind broke)
  await item.update({ "system.serviceMode": "oneoff" });
  const live2 = actor.items.get(item.id);
  const systemStripped = live2.system?.serviceMode === undefined;
  const modeStillFromFlag = svc.serviceModeOf(live2);

  // (3) the item sheet now exposes the normalized context vars for the settings partial
  let ctx = {};
  try { const c = await live2.sheet._prepareContext({}); ctx = { serviceMode: c.serviceMode, servicePeriod: c.servicePeriod }; } catch(e){ ctx = { err: e.message }; }

  await actor.delete().catch(()=>{});
  return { persisted, systemStripped, modeStillFromFlag, ctx };
});

console.log("\n===== B6: service fields persist in flags =====");
console.log("  after flag write:", JSON.stringify(r.persisted));
console.log("  system.serviceMode stripped by DataModel:", r.systemStripped, "| accessor still reads flag:", r.modeStillFromFlag);
console.log("  item-sheet context vars:", JSON.stringify(r.ctx));
const ok = r.persisted.mode==="recurring" && r.persisted.period==="week" && r.persisted.classified==="recurring"
  && r.systemStripped && r.modeStillFromFlag==="recurring"
  && r.ctx.serviceMode==="recurring" && r.ctx.servicePeriod==="week";
console.log("\n  RESULT: " + (ok ? "PASS ✅ — service mode/period persist in flags, read by accessors + sheet context" : "FAIL ❌"));
await b.close();
process.exit(ok?0:1);
