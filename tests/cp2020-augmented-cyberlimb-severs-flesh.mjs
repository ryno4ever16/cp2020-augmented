/** Fitting a cyberlimb SEVERS the underlying flesh (M18 fiction). Drives the REAL sheet install path
 *  (_cpEquipCyberIntoZone), because the pack cyberlimb is stored equipped-at-a-default-side, so only the
 *  install handler knows the chosen side (the create/equip hook fires too early). Verifies on :30004:
 *  installing into r-arm severs rArm (and l-arm severs lArm — the side is honoured); the sever is MASKED
 *  while the chrome covers the zone; removing the cyberlimb REVEALS the severed stump (badge + ⚕); and a
 *  non-SDP in-limb implant does NOT sever. Needs an active scene. */
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
  const CL = await import("/modules/cp2020-augmented/module/mech/cyberlimb.js");
  const SCOPE = "cp2020-augmented";
  const fleshFlag = (a, z) => (a.getFlag(SCOPE, "fleshLimbStatus") ?? {})[z];
  const ARM_UUID = "Compendium.cyberpunk2020.cyberlimbs.Item.aeiFWzAH0ZSYOjyy"; // Standard Cyberarm, SDP 30

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Sever"))) await a.delete().catch(()=>{});

  /** Install a fresh pack cyberarm into `zoneKey` via the real sheet handler; returns the actor. */
  async function installArm(name, zoneKey) {
    const actor = await Actor.create({ name, type: "character" });
    const src = await fromUuid(ARM_UUID);
    const [arm] = await actor.createEmbeddedDocuments("Item", [game.items.fromCompendium(src)]);
    const sheet = actor.sheet;
    await sheet.render(true); await sleep(500);
    await sheet._cpEquipCyberIntoZone(arm, arm.toObject(), zoneKey);   // the REAL install path
    await sleep(500);
    await sheet.close().catch(()=>{});
    return { actor, arm };
  }

  // (1) right-arm install severs rArm — NOT the pack's default-left side
  const R = await installArm("__PW__SeverR", "r-arm");
  check("install r-arm: fleshLimbStatus.rArm = severed", fleshFlag(R.actor,"rArm") === "severed", fleshFlag(R.actor,"rArm"));
  check("install r-arm: the wrong side (lArm) is NOT severed", fleshFlag(R.actor,"lArm") === undefined, fleshFlag(R.actor,"lArm"));

  // (2) left-arm install severs lArm — the chosen side is honoured both ways
  const L = await installArm("__PW__SeverL", "l-arm");
  check("install l-arm: fleshLimbStatus.lArm = severed", fleshFlag(L.actor,"lArm") === "severed", fleshFlag(L.actor,"lArm"));
  check("install l-arm: the wrong side (rArm) is NOT severed", fleshFlag(L.actor,"rArm") === undefined, fleshFlag(L.actor,"rArm"));

  // (3) masked while the cyberlimb covers the zone — read helper suppresses, sheet shows no flesh badge
  const actor = R.actor;
  check("masked: fleshLimbStatusOf('rArm') === '' while the cyberlimb is present", CL.fleshLimbStatusOf(actor,"rArm") === "", CL.fleshLimbStatusOf(actor,"rArm"));
  const open = async () => { await actor.sheet.render(true); await sleep(900);
    const root = actor.sheet.element;
    root?.querySelector?.('.sheet-tabs [data-tab="combat"], a[data-tab="combat"]')?.click?.(); await sleep(500);
    root.querySelector(".armor-display")?.scrollIntoView({block:"center"}); await sleep(250); return root; };
  let root = await open();
  check("sheet (installed): NO flesh badge on rArm while chromed", !root.querySelector('.cp-flesh-clear[data-zone="rArm"]'), null);
  await actor.sheet.close().catch(()=>{});

  // (4) REMOVE the cyberlimb -> the severed stump is revealed (badge + ⚕)
  await R.arm.update({ "system.equipped": false, "system.EffectActive": false });
  for (let i=0;i<30 && (Number(actor.system?.sdp?.sum?.rArm)||0)>0; i++) await sleep(200);
  await sleep(300);
  check("reveal: fleshLimbStatusOf('rArm') === 'severed' once the cyberlimb is removed", CL.fleshLimbStatusOf(actor,"rArm") === "severed", CL.fleshLimbStatusOf(actor,"rArm"));
  root = await open();
  const badge = root.querySelector(".segment-status-row .segment-limb-status.cp-limb-flesh");
  const clear = root.querySelector('.cp-flesh-clear[data-zone="rArm"]');
  check("sheet (removed): flesh 'severed' badge + ⚕ clear now render on rArm", !!badge && !!clear, { badge: !!badge, clear: !!clear });
  await actor.sheet.close().catch(()=>{});

  // (5) NEGATIVE: a non-SDP in-limb implant does NOT sever the meat
  const actor2 = await Actor.create({ name: "__PW__Sever2", type: "character" });
  const [sub] = await actor2.createEmbeddedDocuments("Item", [{
    name: "Subdermal (non-SDP)", type: "cyberware",
    system: { MountZone: "Arm", CyberBodyType: { Location: "Left" }, CyberWorkType: { SDP: 0 } }
  }]);
  const sh2 = actor2.sheet; await sh2.render(true); await sleep(400);
  await sh2._cpEquipCyberIntoZone(sub, sub.toObject(), "l-arm"); await sleep(400);
  await sh2.close().catch(()=>{});
  check("negative: a non-SDP arm implant does NOT record a flesh sever", fleshFlag(actor2,"lArm") === undefined, fleshFlag(actor2,"lArm"));

  for (const a of [R.actor, L.actor, actor2]) await a.delete().catch(()=>{});
  return out;
});

for (const l of r.checks) console.log(l);
const errs = errors.filter(e => !/screen resolution/i.test(e));
if (errs.length) console.log("errors:", errs.slice(0,5).join(" | "));
const pass = r.fails.length===0 && errs.length===0;
console.log(`\nRESULT: ${pass?"PASS":"FAIL"} ${r.checks.length-r.fails.length}/${r.checks.length}`);
await b.close();
process.exit(pass?0:1);
