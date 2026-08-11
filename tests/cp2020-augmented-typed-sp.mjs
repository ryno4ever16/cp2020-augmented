/** Typed SP (D5 conditional-SP model): the pure per-layer rule (typed match replaces conventional,
 *  non-match falls back, conventional-0 layers are skipped), the sync resolver honoring damageType
 *  through the proportional combine, and the damage-dialog template rendering the type select. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = {};
  const D = await import("/modules/cp2020-augmented/module/data/mech-item-data.js");
  const A = await import("/modules/cp2020-augmented/module/combat/DamageApplicator.js");
  const U = await import("/modules/cp2020-augmented/module/utils.js");
  const AL = await import("/modules/cp2020-augmented/module/combat/armor-layers.js");

  // ── (0) PURE: typedLayerSP truth table ────────────────────────────────────
  const typed = (type, sp) => ({ system: { mechTypedSP: { type, sp } } });
  out.pure = {
    // dual-value shape (sp > 0): matching hit replaces conventional; others fall back
    matchReplaces: D.typedLayerSP(typed("radiation", 6), 16, "radiation"),  // 6, NOT 16
    nonMatchFallback: D.typedLayerSP(typed("radiation", 6), 16, ""),        // 16 — conventional
    // fully-typed garment shape (sp == 0): coverage IS the typed SP — matching keeps it, others 0
    match: D.typedLayerSP(typed("fire", 0), 20, "fire"),           // 20 — coverage counts vs fire
    nonMatchZero: D.typedLayerSP(typed("fire", 0), 20, ""),        // 0 — skipped on a normal hit
    noTyped: D.typedLayerSP({ system: {} }, 12, "fire"),           // 12 — plain armor unaffected
  };

  // ── (1) LIVE: sync resolver with a fire garment over kevlar ──────────────
  // Pre-sweep any prior run's fixture (non-__PW__ name → not caught by a shared sweep).
  for (const a of game.actors.filter(a => a.name?.startsWith("PROBE typed-sp"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "PROBE typed-sp wearer", type: "character" });
  try {
    const cov = (sp) => Object.fromEntries(["Head","Torso","lArm","rArm","lLeg","rLeg"]
      .map(k => [k, { stoppingPower: String(k === "Torso" ? sp : 0), ablation: 0 }]));
    await actor.createEmbeddedDocuments("Item", [
      { name: "PROBE fire coat", type: "armor",
        system: { equipped: true, armorType: "Soft", coverage: cov(20), mechTypedSP: { type: "fire", sp: 0 } } },
      { name: "PROBE kevlar", type: "armor",
        system: { equipped: true, armorType: "Soft", coverage: cov(18) } },
    ]);
    const hitTorso = { Torso: [{ damage: 10 }] };
    const base = { target: actor, areaDamages: hitTorso, ap: false, armorMode: "full" };
    out.live = {
      normalSP: A.resolveAreaDamagesSync({ ...base })[0]?.spFull,                        // 18 (coat skipped)
      fireSP:   A.resolveAreaDamagesSync({ ...base, damageType: "fire" })[0]?.spFull,    // 20+18 → 25 (diff 0-4 = +5)
      heatSP:   A.resolveAreaDamagesSync({ ...base, damageType: "heat" })[0]?.spFull,    // 18 (coat skipped again)
    };
    // Radsuit shape: one layer, typed 6 + conventional 16
    await actor.deleteEmbeddedDocuments("Item", actor.items.map(i => i.id));
    await actor.createEmbeddedDocuments("Item", [
      { name: "PROBE radsuit", type: "armor",
        system: { equipped: true, armorType: "Soft", coverage: cov(16), mechTypedSP: { type: "radiation", sp: 6 } } },
    ]);
    out.live.radNormal = A.resolveAreaDamagesSync({ ...base })[0]?.spFull;                       // 16
    out.live.radTyped  = A.resolveAreaDamagesSync({ ...base, damageType: "radiation" })[0]?.spFull; // 6

    // Typed-SP CYBERWARE (the borg radiation-shielding shape): no conventional Locations SP, so
    // it must stay silent on normal hits and fold its typed rating on a matching hit (the
    // contributor scan admits equipped cyberware with a typed entry regardless of Locations).
    await actor.deleteEmbeddedDocuments("Item", actor.items.map(i => i.id));
    await actor.createEmbeddedDocuments("Item", [
      { name: "PROBE rad shielding", type: "cyberware",
        system: { equipped: true, CyberWorkType: { Types: ["Implant"] }, mechTypedSP: { type: "radiation", sp: 6 } } },
      { name: "PROBE vest", type: "armor",
        system: { equipped: true, armorType: "Soft", coverage: cov(10) } },
    ]);
    out.live.cwNormal = A.resolveAreaDamagesSync({ ...base })[0]?.spFull;                          // 10 — shielding silent
    out.live.cwRad    = A.resolveAreaDamagesSync({ ...base, damageType: "radiation" })[0]?.spFull; // 10+6 → 15 (diff 4 = +5)

    // ── (3) DRIFT-GUARD (LANE-B): utils.foldArmorSP must equal the base-prepared per-location SP for a
    //        layered fixture, and armor-layers must admit typed-SP cyberware as a contributor. ──
    await actor.deleteEmbeddedDocuments("Item", actor.items.map(i => i.id));
    await actor.createEmbeddedDocuments("Item", [
      { name: "PROBE layer kevlar", type: "armor", system: { equipped: true, armorType: "Soft", coverage: cov(18) } },
      { name: "PROBE layer flak",   type: "armor", system: { equipped: true, armorType: "Soft", coverage: cov(20) } },
    ]);
    // base actor.js maxLayeredSP() prepares system.hitLocations.<loc>.stoppingPower; utils.foldArmorSP is a
    // separate copy of the same proportional rule (CP2020 p.99) — assert they agree (no drift): fold(18,20)=25.
    out.parity = { base: Number(actor.system?.hitLocations?.Torso?.stoppingPower) || 0, fold: U.foldArmorSP([18, 20]) };
    // A typed-SP cyberware with NO conventional Locations SP is still admitted as a Torso contributor
    // (armor-layers.typedCw) so typedLayerSP can fold it on a matching hit.
    await actor.createEmbeddedDocuments("Item", [
      { name: "PROBE torso rad shield", type: "cyberware",
        system: { equipped: true, CyberWorkType: { Types: ["Implant"] }, mechTypedSP: { type: "radiation", sp: 6 } } },
    ]);
    const shieldId = actor.items.find(i => i.name === "PROBE torso rad shield")?.id;
    out.layers = { typedAdmitted: AL.getArmorContributors(actor, "Torso").cwItems.some(i => i.id === shieldId) };

    // ── (2) UI: the dialog renders the damage-type select — now 3 options (Normal/Fire/Heat). "Radiation"
    //        was removed (it moved to the Deep Space DOSE subsystem, module/radiation/ — no longer a per-hit
    //        SP type). The dual-value typedLayerSP + typedCw mechanisms above stay type-agnostic. ─────────
    const rt = foundry?.applications?.handlebars?.renderTemplate ?? renderTemplate;
    const html = await rt("modules/cp2020-augmented/templates/dialog/damage-dialog.hbs", {
      weaponName: "probe", targetName: actor.name, resolvedHits: [], totalNet: 0, btm: 0,
      armorMode: "full", ablate: false, armorModes: ["full","simple","none"], ap: false,
      coverSP: 0, damageType: "",
    });
    const div = document.createElement("div"); div.innerHTML = html;
    const sel = div.querySelector("select[name='damageType']");
    out.ui = {
      selectRendered: !!sel,
      optionCount: sel?.options?.length ?? 0,
      normalSelected: sel?.value === "",
      noRawKeys: !html.includes("CYBERPUNK.DamageDlgType"),
    };
  } finally {
    await actor.delete().catch(() => {});
  }
  return out;
});

const checks = {
  pureMatch: r.pure?.match === 20,
  pureMatchReplaces: r.pure?.matchReplaces === 6,
  pureNonMatchFallback: r.pure?.nonMatchFallback === 16,
  pureNonMatchZero: r.pure?.nonMatchZero === 0,
  pureNoTyped: r.pure?.noTyped === 12,
  liveNormalSkipsCoat: r.live?.normalSP === 18,
  liveFireCombines: r.live?.fireSP === 25,
  liveHeatSkipsCoat: r.live?.heatSP === 18,
  liveRadNormal: r.live?.radNormal === 16,
  liveRadTypedReplaces: r.live?.radTyped === 6,
  liveCwTypedSilentOnNormal: r.live?.cwNormal === 10,
  liveCwTypedFoldsOnMatch: r.live?.cwRad === 15,
  parityFoldMatchesBasePreparedSP: r.parity?.base === r.parity?.fold && (r.parity?.base || 0) > 20,
  armorLayersAdmitsTypedCw: r.layers?.typedAdmitted === true,
  uiSelect: r.ui?.selectRendered === true && r.ui?.optionCount === 3 && r.ui?.normalSelected === true, // Normal/Fire/Heat (radiation removed → dose subsystem)
  uiNoRawKeys: r.ui?.noRawKeys === true,
  noConsoleErrors: errors.length === 0,
};
console.log(JSON.stringify({ r, checks, errors }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? "TYPED-SP KEEPER PASS" : "TYPED-SP KEEPER FAIL");
await b.close();
process.exit(pass ? 0 : 1);
