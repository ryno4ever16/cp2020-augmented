/** Pre-flight for the battery baseline. Reads (and where documented, restores) the three world
 *  conditions that produce spurious reds across many suites at once:
 *    1. an ACTIVE scene (no active scene => canvas.ready false => ~10 suites red with no defect),
 *    2. the mechDocumentAutomation world setting left OFF by an earlier suite's exit,
 *    3. stray __PW__ fixture actors left behind by an earlier suite's exit.
 *  Report-only for anything not on that list. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = {};
  out.core = game.version;
  out.system = `${game.system.id} ${game.system.version}`;
  out.module = game.modules.get("cp2020-augmented")?.version;
  out.moduleActive = game.modules.get("cp2020-augmented")?.active;

  // 1. active scene
  out.activeSceneBefore = game.scenes.active?.name ?? null;
  if (!game.scenes.active) {
    const target = game.scenes.getName("Foundry Virtual Tabletop") ?? game.scenes.contents[0];
    if (target) await target.activate();
    await new Promise((res) => setTimeout(res, 4000));
  }
  out.activeSceneAfter = game.scenes.active?.name ?? null;
  out.canvasReady = canvas?.ready === true;

  // 2. the automation master setting a prior suite may have left off
  try {
    out.mechDocumentAutomationBefore = game.settings.get("cp2020-augmented", "mechDocumentAutomation");
    if (out.mechDocumentAutomationBefore === false) {
      await game.settings.set("cp2020-augmented", "mechDocumentAutomation", true);
    }
    out.mechDocumentAutomationAfter = game.settings.get("cp2020-augmented", "mechDocumentAutomation");
  } catch (e) { out.mechDocumentAutomationErr = e.message; }

  // 3. stray fixtures — actors, items, AND scenes. Scenes were missing here: a suite that dies before
  //    its own scene delete leaves a `__PW__…Scene` that survives every later run, and a cleanup leg
  //    counting the shared prefix then reds forever for another suite's crash. Never remove the ACTIVE
  //    scene (that is the very condition step 1 exists to guarantee).
  const strayA = game.actors.filter((a) => a.name.startsWith("__PW__"));
  const strayI = game.items.filter((i) => i.name.startsWith("__PW__"));
  const strayS = game.scenes.filter((s) => s.name.startsWith("__PW__") && !s.active);
  out.strayActorsBefore = strayA.length;
  out.strayItemsBefore = strayI.length;
  out.strayScenesBefore = strayS.map((s) => s.name);
  for (const a of strayA) await a.delete().catch(() => {});
  for (const i of strayI) await i.delete().catch(() => {});
  for (const s of strayS) await s.delete().catch(() => {});
  out.strayActorsAfter = game.actors.filter((a) => a.name.startsWith("__PW__")).length;
  out.strayScenesAfter = game.scenes.filter((s) => s.name.startsWith("__PW__")).length;

  out.actorCount = game.actors.size;
  out.messageCount = game.messages.size;
  out.sceneCount = game.scenes.size;
  return out;
});

console.log(JSON.stringify(r, null, 1));
await b.close();
process.exit(0);
