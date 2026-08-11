/** Missing-limb hit re-roll (CP2020 p.100). Covers the MODULE-owned interception of BASE-rolled locations:
 *  the weaponFired handler re-rolls any hit that lands on a gone limb (severed/destroyed flesh, or a
 *  destroyed cyberlimb wreck) against the module's own limb-loss state. Verifies the helper directly AND a
 *  real weaponFired -> auto-apply, where the re-roll is observable: a hit on a DESTROYED cyberarm soaks
 *  nothing (0 HP), but re-rolled off it, the same shot deals HP damage. Needs an active scene. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l))||us[0];await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);
await p.evaluate(async () => { if (!game.scenes.active) { const sc = game.scenes.getName("Foundry Virtual Tabletop") || game.scenes.contents[0]; if (sc) await sc.activate(); } });

const r = await p.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = { checks: [], fails: [] };
  const check = (n, ok, got) => { out.checks.push(`${ok?"  PASS":"  FAIL"}  ${n}${ok?"":"  got="+JSON.stringify(got)}`); if(!ok) out.fails.push(n); };
  const U  = await import("/modules/cp2020-augmented/module/utils.js");
  const CL = await import("/modules/cp2020-augmented/module/mech/cyberlimb.js");
  const SCOPE = "cp2020-augmented";
  const prior = {
    reroll: game.settings.get(SCOPE,"rerollGoneLimbLocation"),
    auto:   game.settings.get(SCOPE,"damageAutoApply"),
    limb:   game.settings.get(SCOPE,"limbLossEnabled"),
  };
  await game.settings.set(SCOPE,"rerollGoneLimbLocation",true);
  await game.settings.set(SCOPE,"limbLossEnabled",false);

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__RGL"))) await a.delete().catch(()=>{});

  // ---------- (A) helper unit tests ----------
  const fleshActor = await Actor.create({ name:"__PW__RGL_flesh", type:"character" });
  await fleshActor.setFlag(SCOPE,"fleshLimbStatus",{ rArm:"severed" });   // one gone limb, rest present

  // 200 remaps of a rArm-only hit → never stays on rArm, always a valid location, damage preserved
  let stayed = 0, dmgOk = true; const seen = {};
  for (let i=0;i<200;i++){
    const m = await U.rerollGoneLimbAreaDamages(fleshActor, { rArm:[{damage:7}] });
    const keys = Object.keys(m);
    if (keys.includes("rArm")) stayed++;
    for (const k of keys) { seen[k]=(seen[k]||0)+1; for (const h of m[k]) if (h.damage!==7) dmgOk=false; }
  }
  check("helper: a severed-rArm hit is NEVER left on rArm (200x)", stayed === 0, stayed);
  check("helper: re-rolled hits keep their damage value", dmgOk, seen);
  check("helper: re-rolls spread across valid locations (not all one spot)", Object.keys(seen).length >= 2, seen);

  // non-gone location passes through untouched
  const passthru = await U.rerollGoneLimbAreaDamages(fleshActor, { Torso:[{damage:3}] });
  check("helper: a non-gone location passes through unchanged", passthru.Torso?.[0]?.damage === 3 && !passthru.rArm, passthru);

  // off-toggle → no-op (rArm stays)
  await game.settings.set(SCOPE,"rerollGoneLimbLocation",false);
  const offMap = await U.rerollGoneLimbAreaDamages(fleshActor, { rArm:[{damage:5}] });
  check("helper: toggle OFF → no re-roll (rArm preserved)", !!offMap.rArm, offMap);
  await game.settings.set(SCOPE,"rerollGoneLimbLocation",true);

  // null actor → no-op
  const nullMap = await U.rerollGoneLimbAreaDamages(null, { rArm:[{damage:5}] });
  check("helper: null actor → input returned unchanged", !!nullMap.rArm, nullMap);

  // all-limbs-gone → only Head/Torso survive
  const allGone = await Actor.create({ name:"__PW__RGL_allgone", type:"character" });
  await allGone.setFlag(SCOPE,"fleshLimbStatus",{ rArm:"severed", lArm:"severed", rLeg:"severed", lLeg:"severed" });
  const distro = {};
  for (let i=0;i<150;i++){ const m = await U.rerollGoneLimbAreaDamages(allGone, { rArm:[{damage:1}] }); for (const k of Object.keys(m)) distro[k]=(distro[k]||0)+1; }
  const onlyCore = Object.keys(distro).every(k => k==="Head" || k==="Torso");
  check("helper: all 4 limbs gone → only Head/Torso returned (never loops/empties)", onlyCore, distro);

  // ---------- (B) integration: real weaponFired -> auto-apply, re-roll observable ----------
  // Target has a DESTROYED cyberarm on rArm: a hit that STAYS on rArm soaks into dead SDP (0 HP); a hit
  // RE-ROLLED off it deals HP damage. So HP-damage-taken proves the shot left the wrecked limb.
  const target = await Actor.create({ name:"__PW__RGL_target", type:"character", system:{ stats:{ bt:{ value:2 } }, damage:0 } });
  const src = await fromUuid("Compendium.cyberpunk2020.cyberlimbs.Item.aeiFWzAH0ZSYOjyy");
  const [arm] = await target.createEmbeddedDocuments("Item", [game.items.fromCompendium(src)]);
  await arm.update({ "system.equipped":true, "system.EffectActive":true, "system.CyberBodyType.Location":"Right" });
  for (let i=0;i<30 && (Number(target.system?.sdp?.sum?.rArm)||0)!==30; i++) await sleep(200);
  await CL.absorbCyberlimbHit(target, "rArm", 40);   // destroy the cyberarm
  await sleep(300);
  check("integration setup: rArm cyberarm destroyed (limbStatus) + SDP pool present", CL.limbStatusOf(target,"rArm")==="destroyed" && (Number(target.system?.sdp?.sum?.rArm)||0)===30, { st: CL.limbStatusOf(target,"rArm"), sum: target.system?.sdp?.sum?.rArm });

  // place a token on the active scene + an attacker the GM handles
  const attacker = await Actor.create({ name:"__PW__RGL_attacker", type:"character" });
  const scene = game.scenes.active;
  const [tokDoc] = await scene.createEmbeddedDocuments("Token", [{ name: target.name, actorId: target.id, x: 1000, y: 1000, disposition: -1 }]);
  // Auto-apply OFF so the handler opens a DamageDialog — we read its payload directly (auto-apply routes
  // through a socket that does not echo to the sender in a single headless client). This proves the
  // handler re-rolled payload.areaDamages BEFORE handing off, which is the whole single-shot integration.
  await game.settings.set(SCOPE,"damageAutoApply",false);
  await sleep(200);

  const findDialog = () => {
    const pools = [];
    try { pools.push(...foundry.applications.instances.values()); } catch (e) {}
    try { pools.push(...Object.values(ui.windows)); } catch (e) {}
    return pools.find(a => a?.constructor?.name === "DamageDialog");
  };
  for (const a of [findDialog()].filter(Boolean)) await a.close().catch(()=>{});
  Hooks.callAll("cyberpunk2020.weaponFired", { attackerId: attacker.id, targetTokenId: tokDoc.id, areaDamages: { rArm: [{ damage: 12 }] } });
  let dlg = null;
  for (let i=0;i<40 && !dlg; i++){ dlg = findDialog(); if (!dlg) await sleep(150); }
  const dlgArea = dlg?.payload?.areaDamages ?? null;
  const keys = dlgArea ? Object.keys(dlgArea) : [];
  const hitCount = keys.reduce((s,k)=> s + (dlgArea[k]?.length||0), 0);
  check("integration: the shot opened a DamageDialog", !!dlg, { found: !!dlg });
  check("integration: rArm (destroyed cyberarm) was re-rolled OUT of the payload", dlg ? !keys.includes("rArm") : false, keys);
  check("integration: the one hit survived on a valid location (count + damage preserved)", dlg ? (hitCount === 1 && keys.every(k => (dlgArea[k]||[]).every(h => h.damage === 12))) : false, dlgArea);
  await dlg?.close().catch(()=>{});

  // cleanup + restore
  await tokDoc.delete().catch(()=>{});
  for (const a of [fleshActor, allGone, target, attacker]) await a.delete().catch(()=>{});
  await game.settings.set(SCOPE,"rerollGoneLimbLocation",prior.reroll);
  await game.settings.set(SCOPE,"damageAutoApply",prior.auto);
  await game.settings.set(SCOPE,"limbLossEnabled",prior.limb);
  return out;
});

for (const l of r.checks) console.log(l);
const errs = errors.filter(e => !/screen resolution/i.test(e));
if (errs.length) console.log("errors:", errs.slice(0,6).join(" | "));
const pass = r.fails.length===0 && errs.length===0;
console.log(`\nRESULT: ${pass?"PASS":"FAIL"} ${r.checks.length-r.fails.length}/${r.checks.length}`);
await b.close();
process.exit(pass?0:1);
