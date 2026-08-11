/** ACPA Unit D — combat-model toggle CONFIRM gesture. Drives the real sheet select: a non-at-risk suit
 *  changes pole with no dialog; a damaged suit raises the "are you sure?" confirm, and CANCEL is authoritative
 *  (reverts the select + the stored value past the named-select submitOnChange race) while CONFIRM applies.
 *  Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-acpa-toggle-gesture.mjs */
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
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const rootOf = (sheet) => sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
  // Only match MY confirm dialog — scoped by its UNIQUE title/warn text ("Change combat model?" /
  // "damage models"), which the sheet's own "Combat model" label does NOT contain.
  const dlgBtn = (action) => {
    for (const btn of document.querySelectorAll(`button[data-action="${action}"]`)) {
      const c = btn.closest(".application, .dialog, dialog, .window-app");
      if (c && /change combat model|damage models/i.test(c.textContent || "")) return btn;
    }
    return null;
  };
  const pollBtn = async (action, ms = 3000) => { for (let i = 0; i < ms / 150; i++) { const el = dlgBtn(action); if (el) return el; await sleep(150); } return null; };
  const storedOf = (id) => game.actors.get(id).system.acpaCombatModel;

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__ACPATog"))) await a.delete().catch(() => {});

  // ── (1) NON-at-risk suit: changing the pole writes directly, NO dialog ──
  const fresh = await Actor.create({ name: "__PW__ACPATog Fresh", type: "cp2020-augmented.vehicle", system: { isACPA: true, str: 25, acpaCombatModel: "detailed" } });
  await fresh.sheet.render(true); await sleep(700);
  const froot = rootOf(fresh.sheet);
  const fsel = froot?.querySelector('select[name="system.acpaCombatModel"]');
  out.freshSelPresent = !!fsel;
  { const fs = game.actors.get(fresh.id).system;
    out.freshDiag = { atRisk: fresh.sheet?._acpaSuitAtRisk?.() ?? null, hasCombat: !!game.combat, combatants: game.combat?.combatants?.size ?? 0,
      strDamage: fs.strDamage, refDamage: fs.refDamage, damagedSystems: fs.damagedSystems, destroyed: fs.destroyed, immobilized: fs.immobilized, sdp: fs.sdp }; }
  if (fsel) { fsel.value = "quickkill"; fsel.dispatchEvent(new Event("change", { bubbles: true })); }
  const strayDlg = await pollBtn("no", 1200);                 // should NOT appear (not at risk)
  await sleep(400);
  ok("fresh_no_dialog", !strayDlg);
  ok("fresh_direct_write", storedOf(fresh.id) === "quickkill");
  if (strayDlg) strayDlg.click();                             // dismiss if one wrongly appeared, so it can't block later steps
  await fresh.sheet.close().catch(() => {});

  // ── (2) AT-RISK suit + CANCEL: dialog appears, cancel reverts the stored value ──
  const dmg = await Actor.create({ name: "__PW__ACPATog Dmg", type: "cp2020-augmented.vehicle", system: { isACPA: true, str: 30, acpaCombatModel: "detailed", strDamage: 5 } });
  await dmg.sheet.render(true); await sleep(700);
  let droot = rootOf(dmg.sheet);
  let dsel = droot?.querySelector('select[name="system.acpaCombatModel"]');
  out.dmgSelPresent = !!dsel;
  if (dsel) { dsel.value = "quickkill"; dsel.dispatchEvent(new Event("change", { bubbles: true })); }
  const noBtn = await pollBtn("no", 3500);
  ok("atrisk_dialog_shown", !!noBtn);
  if (noBtn) noBtn.click();                                   // CANCEL
  await sleep(800);
  ok("cancel_reverts_stored", storedOf(dmg.id) === "detailed");   // capture-phase suppressed the write; nothing changed
  // the sheet re-rendered on cancel — poll the FRESH select (the old ref is detached) for the reverted value
  let selVal = null;
  for (let i = 0; i < 20; i++) { await sleep(150); const rr = rootOf(dmg.sheet)?.querySelector('select[name="system.acpaCombatModel"]'); selVal = rr?.value ?? null; if (selVal === "detailed") break; }
  ok("cancel_reverts_select", selVal === "detailed");
  dsel = rootOf(dmg.sheet)?.querySelector('select[name="system.acpaCombatModel"]');

  // ── (3) AT-RISK suit + CONFIRM: dialog appears, confirm applies the new pole ──
  if (dsel) { dsel.value = "quickkill"; dsel.dispatchEvent(new Event("change", { bubbles: true })); }
  const yesBtn = await pollBtn("yes", 3500);
  ok("confirm_dialog_shown", !!yesBtn);
  if (yesBtn) yesBtn.click();                                 // CONFIRM
  await sleep(800);
  ok("confirm_applies", storedOf(dmg.id) === "quickkill");
  await dmg.sheet.close().catch(() => {});

  await fresh.delete().catch(() => {});
  await dmg.delete().catch(() => {});
  return out;
});

console.log("\n===== ACPA Unit D — combat-model toggle CONFIRM gesture =====");
for (const [k, v] of Object.entries(r.checks)) console.log(`  ${v ? "✅" : "❌"} ${k}`);
console.log("  fresh/dmg select present:", r.freshSelPresent, r.dmgSelPresent);
console.log("  freshDiag:", JSON.stringify(r.freshDiag));
console.log("  page errors:", errors.length ? errors.slice(0, 5) : "none");
const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
const pass = failed.length === 0 && errors.length === 0;
console.log("\n  RESULT: " + (pass ? `PASS ✅ — ${Object.keys(r.checks).length}/${Object.keys(r.checks).length} checks`
  : `FAIL ❌ — ${failed.join(", ") || "(none)"}${errors.length ? " · errors: " + errors.length : ""}`));
await b.close();
process.exit(pass ? 0 : 1);
