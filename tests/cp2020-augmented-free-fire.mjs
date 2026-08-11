/**
 * Free Fire on vanilla (:30004, unit ⑤) — the ammo-tracking opt-out the base system lacks.
 *
 * The toggle rides the base's V1 Attack Modifiers window (an injected row); the mechanism keeps
 * every ranged magazine topped while Free Fire is ON, so vanilla's hardcoded consumption and its
 * pre-fire block-on-empty never see a depleted magazine. Tracking back ON = decreases stick again.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-free-fire.mjs
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
  const SCOPE = "cp2020-augmented";
  try {
    const FF = await import("/modules/cp2020-augmented/module/mech/free-fire.js");
    for (const a of game.actors.filter(a => a.name.startsWith("__PW__FreeFire"))) await a.delete().catch(() => {});
    const actor = await Actor.create({ name: "__PW__FreeFire", type: "character" });
    const [weapon] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__FFPistol", type: "weapon",
      system: { weaponType: "Pistol", attackType: "ranged", damage: "2d6+1", shots: 10, shotsLeft: 3 } }]);
    out.defaultTracking = FF.ammoTrackingOn(actor) === true;   // absent flag = vanilla behavior

    // The injected dialog row (real render of the base's V1 window + a real checkbox click).
    const { ModifiersDialog } = await import("/systems/cyberpunk2020/module/dialog/modifiers.js");
    const md = new ModifiersDialog(actor, { weapon, modifierGroups: [], targetTokens: [], onConfirm() {} });
    md.render(true);
    let v1app = null;
    for (let i = 0; i < 30 && !v1app; i++) { await sleep(200); v1app = Object.values(ui.windows ?? {}).find(w => w?.options?.id === "weapon-modifier" && w.rendered); }
    const rowBox = v1app?.element?.[0]?.querySelector?.(".cp-free-fire-row input.cp-ammo-tracking") ?? null;
    out.rowInjected = !!rowBox;
    out.rowChecked = rowBox?.checked === true;   // reflects tracking-on

    // Real gesture: unchecking flips the flag to Free Fire and tops the magazine (3 -> 10).
    rowBox?.click(); await sleep(600);
    out.flagAfterClick = actor.getFlag(SCOPE, "ammoTracking");
    out.toppedOnEnable = Number(actor.items.get(weapon.id)?.system?.shotsLeft) === 10;

    // A consumption write while Free Fire is ON refills to capacity (whatever path wrote it).
    await weapon.update({ "system.shotsLeft": 6 }); await sleep(500);
    out.refillAfterSpend = Number(actor.items.get(weapon.id)?.system?.shotsLeft) === 10;

    // Tracking back ON: decreases stick again (the negative case).
    await actor.setFlag(SCOPE, "ammoTracking", true);
    await weapon.update({ "system.shotsLeft": 4 }); await sleep(500);
    out.sticksWhenTracking = Number(actor.items.get(weapon.id)?.system?.shotsLeft) === 4;

    await md.close().catch(() => {});
    await actor.delete().catch(() => {});

    // ── coord(3) PURE: a Weapon-typed cyberware reports its OWN range/rof/shotsLeft to rangedModifiers
    //     (through _getWeaponSystem), not the 50m fallback; roundsFired max = min(rof, shotsLeft). ──
    const { rangedModifiers } = await import("/modules/cp2020-augmented/module/lookups.js");
    const cyberWeaponStub = {
      _getWeaponSystem: () => ({ range: 30, rof: 3, shotsLeft: 2, weaponType: "Pistol", attackType: "ranged" }),
      __getFireModes: () => ["SemiAuto"],
      system: {},
    };
    const rmGroups = rangedModifiers(cyberWeaponStub).flat();
    const rangeRow = rmGroups.find(m => m.localKey === "Range");
    const rangeLong = rangeRow?.choices?.find(c => c.value === "RangeLong");
    const rfRow = rmGroups.find(m => m.dataPath === "roundsFired");
    out.cyberRanged = { rangeFromImplant: Number(rangeLong?.localData?.range), roundsFiredMax: Number(rfRow?.max) };

    // ── coord(1) V2 dialog: the MODULE's own ModifiersDialog ships a NATIVE .cp-ammo-tracking row and
    //     the V1 injection skip-guard bails on it (no .cp-free-fire-row duplicate); clicking flips the
    //     MODULE-scope flag (never the base scope) and tops magazines. ──
    const v2actor = await Actor.create({ name: "__PW__FreeFireV2", type: "character" });
    const [v2weapon] = await v2actor.createEmbeddedDocuments("Item", [{ name: "__PW__FFV2Pistol", type: "weapon",
      system: { weaponType: "Pistol", attackType: "ranged", damage: "2d6+1", shots: 10, shotsLeft: 3 } }]);
    const { ModifiersDialog: V2Dialog } = await import("/modules/cp2020-augmented/module/dialog/modifiers.js");
    const v2 = new V2Dialog(v2actor, { weapon: v2weapon, modifierGroups: [], targetTokens: [], onConfirm() {} });
    await v2.render(true);
    let v2box = null;
    for (let i = 0; i < 40 && !v2box; i++) { await sleep(150); v2box = v2.element?.querySelector?.("input.cp-ammo-tracking"); }
    out.v2 = {
      nativeRowCount: v2.element?.querySelectorAll?.("input.cp-ammo-tracking")?.length ?? 0,   // exactly 1
      noInjectedDuplicate: !v2.element?.querySelector?.(".cp-free-fire-row"),                  // injection skipped
      checkedReflectsTracking: v2box?.checked === true,                                        // default ON = checked
    };
    v2box?.click(); await sleep(500);
    out.v2.flagModuleScope = v2actor.getFlag(SCOPE, "ammoTracking");                            // false (module scope)
    out.v2.flagNotBaseScope = v2actor.getFlag("cyberpunk2020", "ammoTracking") ?? null;         // base scope untouched
    out.v2.toppedOnEnable = Number(v2actor.items.get(v2weapon.id)?.system?.shotsLeft) === 10;   // magazine topped
    await v2.close().catch(() => {});
    await v2actor.delete().catch(() => {});

    // ── coord(2) cyberware weapon: an implant carrying a CyberWorkType.Weapon block is topped by
    //     topUpRangedWeapons; with Free Fire ON, a decrease to its nested shotsLeft is rewritten to cap
    //     SYNCHRONOUSLY (preUpdateItem rewrite — assert immediately after the update resolves). ──
    const cwActor = await Actor.create({ name: "__PW__FreeFireCW", type: "character" });
    const [cwGun] = await cwActor.createEmbeddedDocuments("Item", [{ name: "__PW__CWGun", type: "cyberware",
      system: { equipped: true, CyberWorkType: { Types: ["Weapon"], Weapon: { weaponType: "Pistol", attackType: "ranged", shots: 8, shotsLeft: 2, range: 30, rof: 3 } } } }]);
    await cwActor.setFlag(SCOPE, "ammoTracking", false);   // Free Fire on
    await FF.topUpRangedWeapons(cwActor);
    const cwLeft = () => Number(cwActor.items.get(cwGun.id)?.system?.CyberWorkType?.Weapon?.shotsLeft);
    out.cwTopUp = cwLeft() === 8;
    await cwGun.update({ "system.CyberWorkType.Weapon.shotsLeft": 3 });   // rewritten to 8 synchronously
    out.cwSyncRefill = cwLeft() === 8;
    await cwActor.delete().catch(() => {});
  } catch (e) { out.err = e?.message || String(e); }
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["default = vanilla tracking (absent flag reads ON)", r.defaultTracking === true],
  ["the row rides the base V1 Modifiers window and reflects the state", r.rowInjected === true && r.rowChecked === true],
  ["unchecking flips the flag and tops the magazine (3 -> 10)", r.flagAfterClick === false && r.toppedOnEnable === true],
  ["a consumption write while ON refills to capacity", r.refillAfterSpend === true],
  ["tracking restored: decreases stick (4 stays 4)", r.sticksWhenTracking === true],
  ["coord3 pure: cyberware ranged-mods use the implant's OWN range (30, not the 50m fallback)", r.cyberRanged?.rangeFromImplant === 30],
  ["coord3 pure: roundsFired max = min(rof, shotsLeft) = 2", r.cyberRanged?.roundsFiredMax === 2],
  ["coord1 V2 dialog: exactly one native ammo-tracking control, no injected duplicate row", r.v2?.nativeRowCount === 1 && r.v2?.noInjectedDuplicate === true],
  ["coord1 V2 dialog: the control reflects ammoTrackingOn (default ON = checked)", r.v2?.checkedReflectsTracking === true],
  ["coord1 V2 dialog: click flips the MODULE-scope flag (base scope untouched) and tops magazines", r.v2?.flagModuleScope === false && r.v2?.flagNotBaseScope === null && r.v2?.toppedOnEnable === true],
  ["coord2 cyberware weapon: topUpRangedWeapons tops the nested magazine to capacity", r.cwTopUp === true],
  ["coord2 cyberware weapon: a decrease is rewritten to cap SYNCHRONOUSLY (preUpdateItem)", r.cwSyncRefill === true],
  ["no fixture/probe error", r.err === null],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
