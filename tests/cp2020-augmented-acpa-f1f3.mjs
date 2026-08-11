/** ACPA book-accuracy fixes F1/F2/F3 (Maximum Metal).
 *  F1 — p.57 external-load overload: external load > ½ chassis Carry → −2 SIB (and thus Run/Jump).
 *  F2 — the four vehicle-only options (Cyberlinked / Fire Control / Damage Control / Composite Armor)
 *       are removed from the ACPA sheet but kept on the plain-vehicle sheet.
 *  F3 — ACPA to-hit purity: an ACPA firer gets NO vehicleLink +2 and NO fireControl bonus (the DFB
 *       covers targeting); plain vehicles keep both. The Cyberlink row is hidden in the ACPA fire dialog.
 *  Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-acpa-f1f3.mjs */
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
  const ok = (k, v) => { out.checks[k] = !!v; };
  const created = [];
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const waitDlg = async (d) => { for (let i = 0; i < 80 && !d?.element?.querySelector("#cp-vf-pen"); i++) await sleep(50); };
  // cleanup prior run
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__ACPAF"))) await a.delete().catch(() => {});
  // Run-4: capture the prior world settings and restore them at the end (the spec used to leave
  // its mutations behind).
  const _priorSettings = {};
  try {
    for (const k of ["mmEnabled", "vehicleDamageEnabled", "vehicleRuleSystem"]) _priorSettings[k] = game.settings.get("cp2020-augmented", k);
    await game.settings.set("cp2020-augmented", "mmEnabled", true);
    await game.settings.set("cp2020-augmented", "vehicleDamageEnabled", true);
    await game.settings.set("cp2020-augmented", "vehicleRuleSystem", "MaximumMetal");
  } catch {}

  const VW = await import("/modules/cp2020-augmented/module/vehicle/vehicle-weapons.js");

  // ════════════════════════════ F1 — MM p.57 external-load overload ════════════════════════════
  // STR 30 chassis → chassisStats(30).carry = 450, so ½ Carry = 225 (the free threshold).
  try {
    const pilotF1 = await Actor.create({ name: "__PW__ACPAF1 Pilot", type: "character" }); created.push(pilotF1);
    await pilotF1.update({ "system.stats.ma.base": 6 });   // MA 6 keeps runM well clear of the 0 floor: runM = (sib+6)*3
    const suitF1 = await Actor.create({ name: "__PW__ACPAF1 Suit", type: "cp2020-augmented.vehicle",
      system: { isACPA: true, str: 30, sp: { front: 20, side: 20, rear: 20, top: 20, bottom: 20 }, carriedGearKg: 0 } });
    created.push(suitF1);
    await suitF1.update({ "system.pilotId": pilotF1.id });
    suitF1.reset();
    const base = game.actors.get(suitF1.id).system;
    const sibBase = Number(base.sib), runBase = Number(base.runM);
    out.f1base = { sib: sibBase, runM: runBase, externalLoadKg: base.externalLoadKg, sibOverloaded: base.sibOverloaded, carry: 450, halfCarry: 225 };
    ok("f1_base_not_overloaded", base.sibOverloaded === false && Number(base.externalLoadKg) === 0);
    ok("f1_base_runM_ma6_formula", runBase === (sibBase + 6) * 3 && runBase >= 6);   // no penalty at 0 load; headroom for −6

    // under (200 < 225): free — SIB + runM unchanged.
    await suitF1.update({ "system.carriedGearKg": 200 }); suitF1.reset();
    let s = game.actors.get(suitF1.id).system;
    ok("f1_under_free", s.sibOverloaded === false && Number(s.sib) === sibBase && Number(s.externalLoadKg) === 200 && Number(s.runM) === runBase);

    // boundary (exactly 225 == ½ Carry): NOT overloaded (book penalizes "between 1/2 and the full rating").
    await suitF1.update({ "system.carriedGearKg": 225 }); suitF1.reset();
    s = game.actors.get(suitF1.id).system;
    ok("f1_boundary_half_not_overloaded", s.sibOverloaded === false && Number(s.sib) === sibBase && Number(s.externalLoadKg) === 225);

    // over (226 > 225): −2 SIB, −6 runM.
    await suitF1.update({ "system.carriedGearKg": 226 }); suitF1.reset();
    s = game.actors.get(suitF1.id).system;
    ok("f1_over_penalty_sib_minus2", s.sibOverloaded === true && Number(s.sib) === sibBase - 2 && Number(s.externalLoadKg) === 226);
    ok("f1_over_runM_minus6", Number(s.runM) === runBase - 6);
    out.f1over = { sib: Number(s.sib), runM: Number(s.runM), externalLoadKg: Number(s.externalLoadKg), sibOverloaded: s.sibOverloaded };

    // external acpaSystem weight is summed into externalLoadKg; internal is excluded.
    await suitF1.update({ "system.carriedGearKg": 200 }); suitF1.reset();   // 200 carried alone is under
    await suitF1.createEmbeddedDocuments("Item", [
      { name: "__PW__Ext Pod", type: "cp2020-augmented.acpaSystem", system: { mount: "external", weight: 50, area: "torso" } },
      { name: "__PW__Int Box", type: "cp2020-augmented.acpaSystem", system: { mount: "internal", weight: 100, area: "torso" } },
    ]);
    suitF1.reset();
    s = game.actors.get(suitF1.id).system;
    // 200 carried + 50 external = 250 (internal 100 excluded). 250 > 225 → overloaded.
    ok("f1_external_summed_internal_excluded", Number(s.externalLoadKg) === 250 && s.sibOverloaded === true);
    out.f1items = { externalLoadKg: Number(s.externalLoadKg), sibOverloaded: s.sibOverloaded };
  } catch (e) { out.f1err = String(e?.message || e); }

  // ════════════════════════════ F3 — ACPA to-hit purity ════════════════════════════
  try {
    // (a) the pure modifier fn still honors BOTH when they are passed (the plain-vehicle path).
    const modBoth = VW.vehicleToHitModifier({ vehicleLink: true, targetingComputer: 5, targetLarge: false });
    const modNone = VW.vehicleToHitModifier({ vehicleLink: false, targetingComputer: 0, targetLarge: false });
    ok("f3_modifier_honors_both", (modBoth - modNone) === 7);   // +2 link + 5 fire-control
    out.f3mod = { modBoth, modNone, delta: modBoth - modNone };

    // (b) ACPA firer with vehicleLink true + fireControl 5 → dialog hides the link row + prefills fire-control 0.
    const acpaFire = await Actor.create({ name: "__PW__ACPAF3 Suit", type: "cp2020-augmented.vehicle",
      system: { isACPA: true, str: 30, vehicleLink: true, fireControl: 5 } });
    created.push(acpaFire);
    const [wAcpa] = await acpaFire.createEmbeddedDocuments("Item",
      [{ name: "__PW__ACPA Gun", type: "cp2020-augmented.vehicleWeapon", system: { weaponClass: "directFire", penetration: 5, rof: 1 } }]);
    const dlgAcpa = await VW.openVehicleFireDialog(acpaFire, { itemId: wAcpa.id });
    await waitDlg(dlgAcpa);
    const aR = dlgAcpa?.element;
    const acpaLink = aR?.querySelector("#cp-vf-link");
    const acpaOther = aR?.querySelector("#cp-vf-other");
    ok("f3_acpa_link_row_hidden", !acpaLink);
    // Run-4 hardening: the fire-control INPUT is now absent for ACPA (a 0 prefill alone still left
    // an editable field that could re-enter the to-hit past the purity gate).
    ok("f3_acpa_firecontrol_input_absent", !acpaOther);
    out.f3acpa = { hasLink: !!acpaLink, hasOther: !!acpaOther };
    try { await dlgAcpa?.close(); } catch {}

    // (c) plain vehicle with the same fields → link row present + checked, fire-control prefilled 5.
    const plain = await Actor.create({ name: "__PW__ACPAF3 Tank", type: "cp2020-augmented.vehicle",
      system: { vehicleLink: true, fireControl: 5 } });
    created.push(plain);
    const [wPlain] = await plain.createEmbeddedDocuments("Item",
      [{ name: "__PW__Tank Gun", type: "cp2020-augmented.vehicleWeapon", system: { weaponClass: "directFire", penetration: 5, rof: 1 } }]);
    const dlgPlain = await VW.openVehicleFireDialog(plain, { itemId: wPlain.id });
    await waitDlg(dlgPlain);
    const pR = dlgPlain?.element;
    const plainLink = pR?.querySelector("#cp-vf-link");
    const plainOther = pR?.querySelector("#cp-vf-other");
    ok("f3_plain_link_present_checked", !!plainLink && plainLink.checked === true);
    ok("f3_plain_firecontrol_prefill_5", plainOther?.value === "5");
    out.f3plain = { hasLink: !!plainLink, checked: plainLink?.checked, other: plainOther?.value };
    try { await dlgPlain?.close(); } catch {}
  } catch (e) { out.f3err = String(e?.message || e); }

  // ════════════════════════════ F2 — dead options gone from the ACPA sheet ════════════════════════════
  const DEAD = ["system.vehicleLink", "system.fireControl", "system.damageControl", "system.compositeArmor"];
  try {
    const acpaSheet = await Actor.create({ name: "__PW__ACPAF2 Suit", type: "cp2020-augmented.vehicle", system: { isACPA: true, str: 30 } });
    created.push(acpaSheet);
    await acpaSheet.sheet.render(true);
    await sleep(800);
    const aRoot = acpaSheet.sheet.element instanceof HTMLElement ? acpaSheet.sheet.element : acpaSheet.sheet.element?.[0];
    const acpaHas = DEAD.filter(n => aRoot?.querySelector(`[name="${n}"]`));
    ok("f2_acpa_four_dead_absent", acpaHas.length === 0);
    ok("f2_acpa_sensors_kept", !!aRoot?.querySelector('[name="system.sensors"]') && !!aRoot?.querySelector('[name="system.antiMissile"]'));
    ok("f2_acpa_carriedgear_input", !!aRoot?.querySelector('[name="system.carriedGearKg"]'));
    out.f2acpa = { stillPresent: acpaHas };
    await acpaSheet.sheet.close().catch(() => {});

    const plainSheet = await Actor.create({ name: "__PW__ACPAF2 Tank", type: "cp2020-augmented.vehicle", system: {} });
    created.push(plainSheet);
    await plainSheet.sheet.render(true);
    await sleep(800);
    const pRoot = plainSheet.sheet.element instanceof HTMLElement ? plainSheet.sheet.element : plainSheet.sheet.element?.[0];
    const plainHas = DEAD.filter(n => pRoot?.querySelector(`[name="${n}"]`));
    ok("f2_plain_four_present", plainHas.length === 4);
    out.f2plain = { present: plainHas };
    await plainSheet.sheet.close().catch(() => {});
  } catch (e) { out.f2err = String(e?.message || e); }

  for (const a of created) await a.delete().catch(() => {});
  try { for (const [k, v] of Object.entries(_priorSettings)) await game.settings.set("cp2020-augmented", k, v); } catch {}
  return out;
});

console.log("\n===== ACPA book-accuracy F1/F2/F3 =====");
console.log("  F1 base:  ", JSON.stringify(r.f1base));
console.log("  F1 over:  ", JSON.stringify(r.f1over));
console.log("  F1 items: ", JSON.stringify(r.f1items), r.f1err ? ("ERR: " + r.f1err) : "");
console.log("  F3 mod:   ", JSON.stringify(r.f3mod));
console.log("  F3 acpa:  ", JSON.stringify(r.f3acpa));
console.log("  F3 plain: ", JSON.stringify(r.f3plain), r.f3err ? ("ERR: " + r.f3err) : "");
console.log("  F2 acpa:  ", JSON.stringify(r.f2acpa));
console.log("  F2 plain: ", JSON.stringify(r.f2plain), r.f2err ? ("ERR: " + r.f2err) : "");
for (const [k, v] of Object.entries(r.checks)) console.log(`  ${v ? "PASS" : "FAIL"} ${k}`);
console.log("  page errors:", errors.length ? errors.slice(0, 5) : "none");

const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
const pass = failed.length === 0 && errors.length === 0;
console.log("\n  RESULT: " + (pass ? `PASS — ${Object.keys(r.checks).length}/${Object.keys(r.checks).length} checks`
  : `FAIL — failed: ${failed.join(", ") || "(none)"}${errors.length ? " · page errors: " + errors.length : ""}`));
await b.close();
process.exit(pass ? 0 : 1);
