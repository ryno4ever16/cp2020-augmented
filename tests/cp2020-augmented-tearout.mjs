/**
 * Tear-out tab verification (:30004, official 1.1.1 + module) — the earmarked live-play findings,
 * re-proven on the MODULE sheet (unit ③ of the pre-release build queue):
 *   #1  two popouts of one actor coexist under distinct window ids (the options.id fix)
 *   #2  detaching the ACTIVE tab switches the parent away — the tab never renders in both places
 *   #1b the life popout carries the shared notes partial (the view/edit toggle, not a dead editor)
 *   #1c the notes view's ink follows the surface (the token-leak fix — never black-on-dark)
 *   #3  the reopen ring spans the WHOLE window frame, not a header control
 * Plus recovery: closing a popout un-marks its nav item on the parent.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-tearout.mjs
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
  const out = { err: null };
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  try {
    for (const a of game.actors.filter(a => a.name.startsWith("__PW__Tearout"))) await a.delete().catch(() => {});
    const actor = await Actor.create({ name: "__PW__Tearout", type: "character" });
    await actor.update({ "system.notes": "<p>__PW__ probe notes</p>" });
    await actor.sheet.render(true); await sleep(900);
    const sheet = actor.sheet;
    const root = sheet.element;

    const { CyberpunkActorTabSheet } = await import("/modules/cp2020-augmented/module/actor/actor-tab-popout.js");

    // #2 setup: make COMBAT the parent's active tab, then detach it.
    sheet._cpTabs?.activate?.("combat"); await sleep(300);
    const activeTab = () => root.querySelector("nav.sheet-tabs .item.active[data-tab]")?.dataset.tab ?? "";
    out.combatActiveBefore = activeTab() === "combat";
    // V2 render() returns a Promise<app> — await it or `.close()` later silently no-ops.
    const pop1 = await CyberpunkActorTabSheet.open(actor, "combat");
    await sleep(900);
    out.parentSwitchedAway = activeTab() !== "" && activeTab() !== "combat";
    out.combatNavMarked = !!root.querySelector('nav.sheet-tabs .item.cp-tab-detached[data-tab="combat"]');
    // The combat tab body must not be displayed on the parent while detached.
    const combatBody = root.querySelector('.sheet-body .tab[data-tab="combat"], .tab[data-tab="combat"]');
    out.combatBodyHidden = !combatBody || !combatBody.classList.contains("active");

    // #1: a second popout coexists under its own window id.
    const pop2 = await CyberpunkActorTabSheet.open(actor, "life");
    await sleep(900);
    const popouts = [...foundry.applications.instances.values()].filter(a => a instanceof CyberpunkActorTabSheet && a.rendered);
    out.twoPopouts = popouts.length === 2;
    out.distinctIds = new Set(popouts.map(a => a.options.id)).size === 2
      && popouts.every(a => /^cp-tab-/.test(a.options.id));

    // #1b + #1c: the life popout renders the shared notes partial; the view ink is not black.
    const lifeEl = pop2?.element ?? popouts.find(a => a.tabKey === "life")?.element;
    const notesView = lifeEl?.querySelector?.(".cp-notes-view");
    out.lifePartial = !!lifeEl?.querySelector?.('[data-action="notes-edit"], .cp-notes-canvas');
    out.notesInk = notesView ? getComputedStyle(notesView).color : "(no view node)";
    out.notesInkNotBlack = !!notesView && out.notesInk !== "rgb(0, 0, 0)";

    // #3: the reopen ring spans the window frame (>= 80% of its area), not a header control.
    const { shimmerWindow } = await import("/modules/cp2020-augmented/module/shimmer.js");
    shimmerWindow(sheet); await sleep(200);
    const frame = sheet.element;
    const ring = frame.querySelector(":scope > .cp-shimmer-ring");
    if (ring) {
      const fr = frame.getBoundingClientRect(), rr = ring.getBoundingClientRect();
      out.ringCoverage = (rr.width * rr.height) / Math.max(1, fr.width * fr.height);
      out.ringWholeFrame = out.ringCoverage >= 0.8;
    } else { out.ringWholeFrame = false; out.ringCoverage = 0; }

    // Recovery: closing the combat popout un-marks the parent nav.
    await pop1?.close?.(); await sleep(600);
    out.navUnmarked = !root.querySelector('nav.sheet-tabs .item.cp-tab-detached[data-tab="combat"]');

    await pop2?.close?.().catch(() => {});
    await sheet.close().catch(() => {});
    await actor.delete().catch(() => {});
  } catch (e) { out.err = e?.message || String(e); }
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["#2: detaching the ACTIVE tab switches the parent away (and marks the nav)", r.combatActiveBefore === true && r.parentSwitchedAway === true && r.combatNavMarked === true],
  ["#2: the detached tab's body is not displayed on the parent", r.combatBodyHidden === true],
  ["#1: two popouts coexist under distinct cp-tab window ids", r.twoPopouts === true && r.distinctIds === true],
  ["#1b: the life popout carries the shared notes partial", r.lifePartial === true],
  ["#1c: the notes view ink follows the surface (not black)", r.notesInkNotBlack === true],
  ["#3: the reopen ring spans the whole window frame", r.ringWholeFrame === true],
  ["recovery: closing the popout un-marks the parent nav", r.navUnmarked === true],
  ["no fixture/probe error", r.err === null],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
