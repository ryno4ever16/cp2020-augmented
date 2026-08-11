/**
 * Pinned subwindows — BOTH window frameworks (:30004, official 1.1.1 + module).
 *
 * The module keeps child windows (confirms, the Attack Modifiers window) floating above the
 * ordinary window they were opened from. The V2 side (DialogV2 + CP_PIN_ON_TOP) was rig-proven at
 * build time; this keeper adds the ship-target gap: the BASE system's Attack Modifiers window is a
 * LEGACY (V1) FormApplication (id "weapon-modifier"), so raising the module's V2 actor sheet must
 * re-float it too (unit ② of the pre-release build queue). z-index is not an animatable property,
 * so reads settle immediately (no transition wait needed).
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-pin-window.mjs
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
    // Both wraps installed (source-shape: the install is idempotent and marks the wrappers).
    out.wrapV2 = foundry.applications.api.ApplicationV2.prototype.bringToFront.__cpPinWrapped === true;
    out.wrapV1 = globalThis.Application?.prototype?.bringToTop?.__cpPinWrapped === true;

    // Fixtures: an actor with a weapon (for the base V1 modifiers window) + its module V2 sheet.
    for (const a of game.actors.filter(a => a.name.startsWith("__PW__PinWin"))) await a.delete().catch(() => {});
    const actor = await Actor.create({ name: "__PW__PinWin", type: "character" });
    const [weapon] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__PinPistol", type: "weapon",
      system: { weaponType: "Pistol", attackType: "ranged", damage: "2d6+1" } }]);
    await actor.sheet.render(true); await sleep(900);
    const sheet = actor.sheet;
    out.sheetIsV2 = !!sheet?.element && !(sheet.element instanceof (globalThis.jQuery ?? function(){}));

    // The BASE system's V1 Attack Modifiers window (id "weapon-modifier"), constructed directly.
    const { ModifiersDialog } = await import("/systems/cyberpunk2020/module/dialog/modifiers.js");
    const md = new ModifiersDialog(actor, { weapon, modifierGroups: [], targetTokens: [], onConfirm() {} });
    md.render(true);
    let v1app = null;
    for (let i = 0; i < 30 && !v1app; i++) { await sleep(200); v1app = Object.values(ui.windows ?? {}).find(w => w?.options?.id === "weapon-modifier" && w.rendered); }
    out.v1Rendered = !!v1app;

    const zOf = (el) => Number((el?.style?.zIndex) || (el?.[0]?.style?.zIndex) || 0);
    const v1El = () => v1app?.element?.[0] ?? v1app?.element ?? null;

    // Raise the ordinary V2 sheet — the pinned V1 window must re-float above it.
    sheet.bringToFront(); await sleep(300);
    out.afterSheetRaise = { sheetZ: zOf(sheet.element), v1Z: zOf(v1El()) };

    // And the V2 confirm regression: a DialogV2 stays above the raised sheet too.
    const dlgPromise = foundry.applications.api.DialogV2.confirm({
      window: { title: "__PW__PinConfirm" }, content: "<p>probe</p>", rejectClose: false });
    let dlg = null;
    for (let i = 0; i < 25 && !dlg; i++) { await sleep(200); dlg = [...foundry.applications.instances.values()].find(a => a.constructor?.name === "DialogV2" && a.rendered); }
    sheet.bringToFront(); await sleep(300);
    out.afterSheetRaise2 = { sheetZ: zOf(sheet.element), dlgZ: dlg ? zOf(dlg.element) : -1, v1Z: zOf(v1El()) };

    await dlg?.close().catch(() => {}); dlgPromise?.catch?.(() => {});
    await md.close().catch(() => {});
    await sheet.close().catch(() => {});
    await actor.delete().catch(() => {});
  } catch (e) { out.err = e?.message || String(e); }
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["both raise paths carry the pin wrap (V2 bringToFront + V1 bringToTop)", r.wrapV2 === true && r.wrapV1 === true],
  ["the base V1 modifiers window renders on the ship target", r.v1Rendered === true],
  ["raising the V2 sheet re-floats the pinned V1 window above it", r.afterSheetRaise && r.afterSheetRaise.v1Z > r.afterSheetRaise.sheetZ],
  ["a V2 confirm stays above the raised sheet (regression)", r.afterSheetRaise2 && r.afterSheetRaise2.dlgZ > r.afterSheetRaise2.sheetZ],
  ["the pinned V1 window stays above through repeated raises", r.afterSheetRaise2 && r.afterSheetRaise2.v1Z > r.afterSheetRaise2.sheetZ],
  ["no fixture/probe error", r.err === null],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
