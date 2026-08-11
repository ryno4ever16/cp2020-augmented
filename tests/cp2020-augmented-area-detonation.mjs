/**
 * Area-flag namespace-fix verification (:30004, official 1.1.1 + module).
 *
 * Regression guard for the bug where area flags are stored under the `cp2020-augmented` scope but the
 * confirm/per-turn readers in combat/damage-hooks.js read `cyberpunk2020` — so a blast was PLACED but
 * never DETONATED on Confirm (and gas clouds never ticked). This drives the full path: a player fires
 * an Explosive at a GM-owned target, the GM Confirms the blast, and we assert the target takes damage.
 *
 * Run from tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-area-detonation.mjs
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinAs(page, match, pws){await page.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=page.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const u=us.find(x=>match.test(x.l));for(const pw of pws){await s.selectOption(u.v);await page.locator('input[name="password"]').fill(pw);await Promise.all([page.waitForNavigation({url:/\/game/,timeout:15000}).catch(()=>{}),page.locator('button[name="join"]').click()]);try{await page.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:15000});return u.l;}catch{await page.goto(BASE+"/join",{waitUntil:"domcontentloaded"}).catch(()=>{});await s.waitFor({state:"visible"}).catch(()=>{});}}throw new Error("join "+u.l);}

const b = await chromium.launch({ headless: true });
let pass=false, log=[];
try {
  const gm = await (await b.newContext({viewport:{width:1600,height:900}})).newPage();
  await joinAs(gm, /gamemaster/i, [GM_PW]);
  await gm.waitForFunction(()=>window.canvas?.ready===true,undefined,{timeout:30000}).catch(()=>{});

  const S = await gm.evaluate(async () => {
    const scene = game.scenes.active ?? canvas.scene; const F=(d)=>d.flags?.["cp2020-augmented"]??{};
    for (const t of scene.tokens.filter(t=>t.name?.startsWith("__PW__"))) await t.delete().catch(()=>{});
    for (const coll of [scene.templates,scene.regions]) if(coll) for(const d of [...coll]) if(F(d).isExplosion||F(d).isGasCloud||F(d).isSpreadZone) await d.delete().catch(()=>{});
    for (const a of game.actors.filter(a=>a.name?.startsWith("__PW__"))) await a.delete().catch(()=>{});
    for (const m of [...game.messages].filter(m=>/PW Grenade/.test(m.content||""))) await m.delete().catch(()=>{});
    // Neutralize the location-doubling settings so the random blast hit-location gives a DETERMINISTIC
    // net (Head-doubling / Listen-Up limb-doubling would make the delta depend on the rolled location).
    // Also pin explosivesDetailed OFF: when it is ON the confirm routes through the HEP-concussion path
    // (SP ignored, BTM applied, then HALVED into permanent + stun → floor((18−2)/2)=8 to the wound
    // track), not the core range-banded blast this fixture asserts (full 18 at centre → 18−BTM). The
    // exact-delta assert below is the core-blast value, so the concussion split must be gated out too.
    let prevHead, prevLimb, prevDetailed;
    try { prevHead = game.settings.get("cp2020-augmented","headHitDoubling"); await game.settings.set("cp2020-augmented","headHitDoubling",false); } catch(e){}
    try { prevLimb = game.settings.get("cp2020-augmented","limbModel"); await game.settings.set("cp2020-augmented","limbModel","core"); } catch(e){}
    try { prevDetailed = game.settings.get("cp2020-augmented","explosivesDetailed"); await game.settings.set("cp2020-augmented","explosivesDetailed",false); } catch(e){}
    const player = game.users.find(u=>u.role===1);
    const npc = await Actor.create({name:"__PW__NPC",type:"character"});
    const pc  = await Actor.create({name:"__PW__PC", type:"character"});
    await pc.update({[`ownership.${player.id}`]:CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER});
    await scene.createEmbeddedDocuments("Token",[{name:pc.name,actorId:pc.id,x:800,y:1000,width:1,height:1}]);
    const [npcTok] = await scene.createEmbeddedDocuments("Token",[{name:npc.name,actorId:npc.id,actorLink:true,x:1400,y:1000,width:1,height:1}]);
    return { playerName:player.name, pcId:pc.id, npcId:npc.id, npcTokenId:npcTok.id, dmg0:Number(npc.system.damage)||0,
             btm:Number(npc.system.stats?.bt?.modifier)||0, prevHead, prevLimb, prevDetailed };
  });

  const pl = await (await b.newContext({viewport:{width:1600,height:900}})).newPage();
  await joinAs(pl, new RegExp(S.playerName.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i"), ["", GM_PW]);
  await pl.waitForFunction(()=>window.canvas?.ready===true,undefined,{timeout:30000}).catch(()=>{});
  await pl.evaluate((d)=>{ Hooks.callAll("cyberpunk2020.weaponFired",{attackerId:d.pcId,targetTokenId:d.npcTokenId,effectTypes:["Explosive"],areaDamages:{Torso:[{damage:18}]},blastRadius:6,weaponName:"PW Grenade"}); }, S);

  // GM confirms the exact blast for this run (target the button by the placed area's id)
  const clicked = await gm.evaluate(async ()=>{
    const scene = game.scenes.active ?? canvas.scene;
    const as = await import("/modules/cp2020-augmented/module/combat/area-shapes.js");
    let id=null; for(let i=0;i<25;i++){ id=as.areasByFlag(scene,"isExplosion").pop()?.doc?.id; if(id)break; await new Promise(r=>setTimeout(r,200)); }
    let btn=null; for(let i=0;i<25;i++){ btn=document.querySelector('.cp-confirm-explosion[data-template-id="'+id+'"]'); if(btn)break; await new Promise(r=>setTimeout(r,200)); }
    if(!btn) return false; btn.click(); return true;
  });
  log.push("GM confirmed blast: " + clicked);

  const after = await gm.evaluate(async (d)=>{ const npc=game.actors.get(d.npcId); for(let i=0;i<30;i++){ const v=Number(npc.system.damage)||0; if(v>d.dmg0) return v; await new Promise(r=>setTimeout(r,200)); } return Number(npc.system.damage)||0; }, S);
  // Exact delta (a double-apply must fail): core blast base 18 at centre, bare NPC (SP 0), doubling +
  // concussion-halving neutralized → net = max(1, 18−BTM).
  const expected = S.dmg0 + Math.max(1, 18 - S.btm);
  log.push(`target damage after Confirm: ${after} (before ${S.dmg0}, expected ${expected}, BTM ${S.btm})`);
  pass = after === expected;

  await gm.evaluate(async (d)=>{ const s=game.scenes.active??canvas.scene; const F=(x)=>x.flags?.["cp2020-augmented"]??{}; for(const t of s.tokens.filter(t=>t.name?.startsWith("__PW__"))) await t.delete().catch(()=>{}); for(const coll of [s.templates,s.regions]) if(coll) for(const x of [...coll]) if(F(x).isExplosion||F(x).isGasCloud||F(x).isSpreadZone) await x.delete().catch(()=>{}); for(const a of game.actors.filter(a=>a.name?.startsWith("__PW__"))) await a.delete().catch(()=>{}); try{ if(d.prevHead!==undefined) await game.settings.set("cp2020-augmented","headHitDoubling",d.prevHead);}catch(e){} try{ if(d.prevLimb!==undefined) await game.settings.set("cp2020-augmented","limbModel",d.prevLimb);}catch(e){} try{ if(d.prevDetailed!==undefined) await game.settings.set("cp2020-augmented","explosivesDetailed",d.prevDetailed);}catch(e){} }, S).catch(()=>{});
} catch(e){ log.push("ERROR: "+e.message); } finally { await b.close(); }
console.log("\n===== BLAST DETONATION (area-flag namespace fix) =====");
log.forEach(l=>console.log("  • "+l));
console.log("\n  RESULT: " + (pass ? "PASS ✅ — placed blast detonates and applies damage on Confirm" : "FAIL ❌"));
process.exit(pass?0:1);
