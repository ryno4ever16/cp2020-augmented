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
let pass=false, log=[]; const legs=[];
// Hoisted so the fixture teardown can run from the `finally` below — a leg that throws mid-run must
// still leave the world clean, which a teardown sitting at the end of the try block cannot promise.
let gm=null, S=null;
try {
  gm = await (await b.newContext({viewport:{width:1600,height:900}})).newPage();
  await joinAs(gm, /gamemaster/i, [GM_PW]);
  await gm.waitForFunction(()=>window.canvas?.ready===true,undefined,{timeout:30000}).catch(()=>{});

  S = await gm.evaluate(async () => {
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
  // ⏪ 2026-08-17 (traceability repair): the verdict used to be one unnamed boolean, so a red could not
  // say whether the placement, the confirm gesture or the applied figure was the half that failed.
  legs.push(["the blast was PLACED and its confirm control reached the referee", clicked === true, String(clicked)]);
  legs.push(["the target took damage at all (the confirm reader found the flag namespace)", after > S.dmg0, `${S.dmg0} → ${after}`]);
  legs.push([`the applied figure is exact — no double-apply (18 at centre less BTM ${S.btm})`, after === expected, `${after} vs ${expected}`]);

  // ══════════════════════ WORD-WARHEAD SUBSTITUTION (added 2026-08-28) ══════════════════════
  //
  // Two related defects in the damage-formula guard, both about a payload that carries NO DICE:
  //   ① a tube holding a diceless round fell through to the STANDARD round's formula, so the round the
  //      referee chambered was silently swapped for a different one;
  //   ② a weapon whose printed damage is the word "Gas" could not be fired at all — the guard declined
  //      it, so the fire path never completed and the module's own cloud mechanic was unreachable.
  // These legs pin the mechanism: the word reader, the ladder's loaded-round rule (with the empty-tube
  // ruling re-run beside it), and the two fire gestures completing with a substituted ZERO formula.
  //
  // ⚠ The fire legs drive `_cpFireThroughDamageGuard` DIRECTLY with a stub thunk rather than through the
  // attack dialog: the guard is the whole subject, the dialog would add a modal gesture with nothing to
  // assert, and the stub is what lets the substituted formula be READ BACK at the moment the base's roll
  // would have consumed it.
  let armed = false; const errs = [];
  gm.on("pageerror", e => { if (armed) errs.push("pageerror: " + e.message); });
  gm.on("console", m => { if (armed && m.type() === "error") errs.push("console: " + m.text()); });

  armed = true;
  const W = await gm.evaluate(async () => {
    const ad = await import("/modules/cp2020-augmented/module/combat/area-delivery.js");
    const heavy = game.packs.get("cyberpunk2020.heavy");
    const supp  = game.packs.find(p => p?.metadata?.packageName === "cp2020-augmented" && p?.metadata?.name === "supplement-heavy");
    if (!heavy || !supp) return { fatal: `pack missing (base heavy=${!!heavy}, module supplement-heavy=${!!supp})` };

    const actor = await Actor.create({ name: "__PW__WordWarhead", type: "character" });
    // One create per call: createEmbeddedDocuments does not guarantee the return order matches its
    // input (recorded in the test-harness memory), and every item here is fetched by its own handle.
    const fromPack = async (pack, id, name) => {
      const doc = await pack.getDocument(id);
      if (!doc) return null;
      const obj = doc.toObject(); obj.name = name; delete obj._id;
      const [made] = await actor.createEmbeddedDocuments("Item", [obj]);
      return made;
    };
    const thrownGas = await fromPack(heavy, "CG2nNDkUA2eroMti", "__PW__Thrown Gas");        // damage: "Gas"
    const tube      = await fromPack(heavy, "u9R4ZnzKOlIFva0o", "__PW__Tube");              // damage: "Varies"
    const gasRound  = await fromPack(supp,  "Cz9eK5iGEGvOQsgl", "__PW__Gas Round");         // effectTypes ["Gas"], no dice
    const fragRound = await fromPack(supp,  "2smdtLN5J0FvhvoS", "__PW__Frag Round");        // bonusDamageFormula 7d6
    if (!thrownGas || !tube || !gasRound || !fragRound) return { fatal: "a catalogue fixture did not resolve from its pack" };
    const [dice] = await actor.createEmbeddedDocuments("Item", [
      { name: "__PW__Dice Weapon", type: "weapon", system: { damage: "2d6", ammoType: "", attackType: "" } }]);

    const load = async (id) => { await tube.update({ "system.ammoItemId": id }); };
    const out = {};

    // ── the word reader ──────────────────────────────────────────────────────────────────────────
    out.wordThrown = ad.wordWarheadOf(thrownGas);            // the weapon's own printed word
    out.wordDice   = ad.wordWarheadOf(dice);                 // an ordinary dice weapon
    await load(gasRound.id);
    out.wordGasLoaded  = ad.wordWarheadOf(tube);             // the round declares the cloud and carries no dice
    out.dmgGasLoaded   = await ad.warheadDamageFor(tube);    // ⛔ must be "", never the fragmentation formula
    await load(fragRound.id);
    out.wordFragLoaded = ad.wordWarheadOf(tube);             // a round with dice keeps them
    out.dmgFragLoaded  = await ad.warheadDamageFor(tube);
    await load("");
    out.dmgNoRound     = await ad.warheadDamageFor(tube);    // the 2026-08-27 empty-tube ruling, re-run

    // ── the fire gesture ─────────────────────────────────────────────────────────────────────────
    const SENTINEL = "__PW__ROLLED__";
    const fire = async (item) => {
      let seen = null;
      const ret = await actor.sheet._cpFireThroughDamageGuard(item, async () => {
        seen = String(item._getWeaponSystem?.()?.damage ?? item.system?.damage ?? "");
        return SENTINEL;
      });
      return { declined: ret === null, reached: ret === SENTINEL, seen };
    };
    out.fireThrown = await fire(thrownGas);                  // the base pack's thrown Gas Grenade
    await load(gasRound.id);
    out.fireGasTube = await fire(tube);                      // the launcher with the gas round chambered
    await load(fragRound.id);
    out.fireFragTube = await fire(tube);                     // control: the ladder still supplies real dice

    await actor.delete().catch(()=>{});
    return out;
  });
  await gm.waitForTimeout(500);
  armed = false;

  if (W?.fatal) {
    legs.push(["the word-warhead fixtures resolved from their packs", false, W.fatal]);
  } else {
    legs.push(["word reader — a weapon printing the word answers it", W.wordThrown === "Gas", String(W.wordThrown)]);
    legs.push(["word reader — an ordinary dice weapon answers nothing", W.wordDice === null, String(W.wordDice)]);
    legs.push(["word reader — a tube holding a diceless cloud round answers the word", W.wordGasLoaded === "Gas", String(W.wordGasLoaded)]);
    legs.push(["word reader — a tube holding a round WITH dice answers nothing", W.wordFragLoaded === null, String(W.wordFragLoaded)]);
    legs.push(["ladder — a loaded diceless round answers with nothing, not the standard round's formula", W.dmgGasLoaded === "", `"${W.dmgGasLoaded}"`]);
    legs.push(["ladder — a loaded round WITH dice answers its own formula", W.dmgFragLoaded === "7d6", `"${W.dmgFragLoaded}"`]);
    legs.push(["ladder — an EMPTY tube still answers the standard round's formula (2026-08-27 ruling)", W.dmgNoRound === "7d6", `"${W.dmgNoRound}"`]);
    legs.push(["fire path — the printed-word weapon is NOT declined", W.fireThrown?.reached === true && W.fireThrown?.declined === false, JSON.stringify(W.fireThrown)]);
    legs.push(["fire path — the printed-word weapon rolls the substituted zero", W.fireThrown?.seen === "0", String(W.fireThrown?.seen)]);
    legs.push(["fire path — the tube holding the diceless round is NOT declined", W.fireGasTube?.reached === true && W.fireGasTube?.declined === false, JSON.stringify(W.fireGasTube)]);
    legs.push(["fire path — that tube rolls the substituted zero, not the standard round's formula", W.fireGasTube?.seen === "0", String(W.fireGasTube?.seen)]);
    legs.push(["fire path — a tube holding a round with dice still rolls that round's formula", W.fireFragTube?.seen === "7d6", String(W.fireFragTube?.seen)]);
  }
  legs.push(["the word-warhead legs raised no page or console error", errs.length === 0, errs.join(" | ") || "none"]);

} catch(e){ log.push("ERROR: "+e.message); legs.push(["the run reached the verdict without throwing", false, e.message]); }
finally {
  if (gm && S) await gm.evaluate(async (d)=>{ const s=game.scenes.active??canvas.scene; const F=(x)=>x.flags?.["cp2020-augmented"]??{}; for(const t of s.tokens.filter(t=>t.name?.startsWith("__PW__"))) await t.delete().catch(()=>{}); for(const coll of [s.templates,s.regions]) if(coll) for(const x of [...coll]) if(F(x).isExplosion||F(x).isGasCloud||F(x).isSpreadZone) await x.delete().catch(()=>{}); for(const a of game.actors.filter(a=>a.name?.startsWith("__PW__"))) await a.delete().catch(()=>{}); try{ if(d.prevHead!==undefined) await game.settings.set("cp2020-augmented","headHitDoubling",d.prevHead);}catch(e){} try{ if(d.prevLimb!==undefined) await game.settings.set("cp2020-augmented","limbModel",d.prevLimb);}catch(e){} try{ if(d.prevDetailed!==undefined) await game.settings.set("cp2020-augmented","explosivesDetailed",d.prevDetailed);}catch(e){} }, S).catch(()=>{});
  await b.close();
}
console.log("\n===== BLAST DETONATION (area-flag namespace fix) =====");
log.forEach(l=>console.log("  • "+l));
console.log("");
for (const [n, p2, d] of legs) console.log(`  [${p2 ? "PASS" : "FAIL"}] ${n}${d ? `  = ${d}` : ""}`);
pass = legs.length > 0 && legs.every(([, p2]) => p2);
console.log("\n  RESULT: " + (pass ? "PASS ✅ — placed blast detonates and applies damage on Confirm"
  : `FAIL ❌ — ${legs.filter(([, p2]) => !p2).map(([n]) => n).join(" · ") || "the run never reached its legs"}`));
process.exit(pass?0:1);
