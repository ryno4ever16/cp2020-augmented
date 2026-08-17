/** Post-battery sweep: remove fixtures the runs created and leave the world in the state the
 *  pre-flight expects. Reports counts for everything it touches; deletes only clearly test-owned
 *  documents (the `__PW__` prefix, the battery's named rig fixtures, and throwaway scenes). */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = {};
  const del = async (docs) => { let n = 0; for (const d of docs) { await d.delete().catch(() => {}); n++; } return n; };

  out.actorsDeleted = await del(game.actors.filter((a) => /^__PW__/.test(a.name) || /^RIG CM Tank$/.test(a.name)));
  out.itemsDeleted  = await del(game.items.filter((i) => /^__PW__/.test(i.name)));
  out.scenesDeleted = await del(game.scenes.filter((s) => /^__PW__/.test(s.name)));
  out.combatsDeleted = await del(game.combats.filter((c) => c.combatants.some((cb) => /^__PW__/.test(cb.name ?? ""))));
  out.usersLeft = game.users.filter((u) => /^__PW__/.test(u.name)).map((u) => u.name);

  // Leave a scene active and the automation master on — the state the pre-flight asserts.
  if (!game.scenes.active) {
    const t = game.scenes.getName("Foundry Virtual Tabletop") ?? game.scenes.contents[0];
    if (t) await t.activate();
    await new Promise((res) => setTimeout(res, 3000));
  }
  out.activeScene = game.scenes.active?.name ?? null;
  out.canvasReady = canvas?.ready === true;
  try {
    if (game.settings.get("cp2020-augmented", "mechDocumentAutomation") === false) {
      await game.settings.set("cp2020-augmented", "mechDocumentAutomation", true);
      out.automationRestored = true;
    }
    out.mechDocumentAutomation = game.settings.get("cp2020-augmented", "mechDocumentAutomation");
  } catch (e) { out.settingErr = e.message; }

  out.finalCounts = { actors: game.actors.size, items: game.items.size, scenes: game.scenes.size, messages: game.messages.size };
  return out;
});

console.log(JSON.stringify(r, null, 1));
await b.close();
process.exit(0);
