/** Scroll-preservation regression (:30004): the actor sheet is ApplicationV2; a re-render (drop, edit)
 *  must NOT reset the tab scroll to the top. The scroller was the frame's section.window-content (an
 *  ancestor of the part, unreachable by AppV2's per-part scroll save/restore); the fix moves the scroll
 *  onto in-part .sheet-body and registers it in PARTS.main scrollable. Verify scrollTop survives a render. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1400, height: 820 } });   // valid FVTT resolution; the tall borg cyber tab overflows anyway
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error" && !/screen resolution/i.test(m.text())) errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = {};
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  // Self-contained fixture (#25): build a borg whose cyber tab overflows, instead of depending on a
  // "Test Borg" actor provisioned by another keeper.
  for (const a of game.actors.filter(a => a.name?.startsWith("__PW__ScrollBorg"))) await a.delete().catch(() => {});
  const borg = await Actor.create({ name: "__PW__ScrollBorg", type: "character" });
  const cyber = game.packs.get("cp2020-augmented.supplement-cyberware") || [...game.packs].find(pk => pk.metadata?.name === "supplement-cyberware");
  const dEntry = cyber ? (await cyber.getIndex()).find(e => e.name === "Dragoon") : null;
  if (dEntry) {
    const dragoon = await cyber.getDocument(dEntry._id);
    const [body] = await borg.createEmbeddedDocuments("Item", [dragoon.toObject()]);
    await body.update({ "system.equipped": true });   // materialize its loadout → a tall cyber tab
    const opts = () => borg.items.filter(i => i.getFlag("cp2020-augmented", "loadoutSource") === body.id);
    { let last = -1, stable = 0; for (let i = 0; i < 80 && stable < 3; i++) { await sleep(200); const n = opts().length; if (n > 0 && n === last) stable++; else { stable = 0; last = n; } } }
  } else {
    const zones = ["Head", "Torso", "Arm", "Leg", "Nervous"];
    await borg.createEmbeddedDocuments("Item", Array.from({ length: 50 }, (_, i) => ({
      name: `__PW__Chrome_${i}`, type: "cyberware",
      system: { equipped: true, EffectMode: "Permanent", MountZone: zones[i % zones.length],
        CyberWorkType: { Types: ["Implant"], Stat: {}, Skill: {}, ChipSkills: {} } } })));
  }
  try {
  await borg.sheet.render(true); await sleep(1200);
  const root = borg.sheet.element;

  // Activate the cyberware tab (tallest content).
  const cyberTab = [...root.querySelectorAll('[data-tab="cyberware"]')].find(el => el.tagName === "A" || el.classList.contains("item"));
  cyberTab?.click(); await sleep(500);

  const body = root.querySelector(".sheet-body");
  out.sheetBodyFound = !!body;
  // The registered scroller must actually be scrollable (content taller than the box).
  out.scrollable = body ? (body.scrollHeight - body.clientHeight) : 0;
  const target = Math.max(40, Math.floor((body?.scrollHeight - body?.clientHeight) / 2) || 40);
  if (body) body.scrollTop = target;
  await sleep(150);
  out.beforeRender = body?.scrollTop ?? -1;

  // A re-render is what used to reset scroll (drops call this.render(true)); simulate it directly.
  await borg.sheet.render(true); await sleep(700);
  const body2 = borg.sheet.element.querySelector(".sheet-body");
  out.afterRender = body2?.scrollTop ?? -1;

  // window-content should no longer be the scroller (overflow moved to .sheet-body).
  const wc = borg.sheet.element.closest(".window-content") || borg.sheet.element.querySelector?.(".window-content");
  out.windowContentScrollTop = wc?.scrollTop ?? -1;
  await borg.sheet.close().catch(() => {});
  } finally {
    await borg.delete().catch(() => {});
  }
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["an actor sheet opened", !r.noActor],
  [".sheet-body is present (the registered scroller)", r.sheetBodyFound === true],
  ["the cyber tab actually overflows .sheet-body (so scroll is meaningful)", (r.scrollable || 0) > 20],
  ["scroll was set before the re-render", (r.beforeRender || 0) > 20],
  ["scroll is PRESERVED across a re-render (not reset to 0)", Math.abs((r.afterRender || 0) - (r.beforeRender || 0)) <= 4],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
