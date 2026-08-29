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
    for (const m of [...game.messages].filter(m=>/__PW__|PW Grenade/.test(m.content||""))) await m.delete().catch(()=>{});
    for (const c of [...game.combats]) await c.delete().catch(()=>{});
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

  // ═══════════════ THE WORD-WARHEAD FAMILY — admission, consequence, expiry (2026-08-28) ═══════════
  //
  // Three more words join the admitted set, each with the consequence that earns it (CP2020 p.64:
  // "Stun (-5 to Stun), Dazzle (Blind for 4 turns), Sonic (deafened 4 turns)"). The legs below pin,
  // in order: the reader's two doors and its closed refusal; the fire gesture completing for all
  // three; the CONSEQUENCE landing on exactly the figures the detonation's own enumeration named;
  // and the timed conditions counting down on the combat's own cadence.
  let armed2 = false; const errs2 = [];
  gm.on("pageerror", e => { if (armed2) errs2.push("pageerror: " + e.message); });
  gm.on("console", m => { if (armed2 && m.type() === "error") errs2.push("console: " + m.text()); });

  armed2 = true;

  // ── ① the reader's two doors, and what is still refused ───────────────────────────────────────
  const R = await gm.evaluate(async () => {
    const ad = await import("/modules/cp2020-augmented/module/combat/area-delivery.js");
    const heavy = game.packs.get("cyberpunk2020.heavy");
    const supp  = game.packs.find(p => p?.metadata?.packageName === "cp2020-augmented" && p?.metadata?.name === "supplement-heavy");
    if (!heavy || !supp) return { fatal: "pack missing" };
    const actor = await Actor.create({ name: "__PW__WordFamily", type: "character" });
    // ⚠ THE SOURCE POINTER IS STAMPED, and the stamped-value legs below are why. The corrections layer
    // matches an owned copy by `_stats.compendiumSource` (data-corrections.js), which is the pointer
    // Foundry writes when a GM drags an item OUT of a compendium — a `toObject()` of the pack document
    // itself carries none, so a fixture built without this line is a copy the corrections cannot
    // recognise and its payload fields read as the schema's zeros. Stamping it here is what makes the
    // fixture the same item a table actually gets.
    const fromPack = async (pack, id, name) => {
      const doc = await pack.getDocument(id); if (!doc) return null;
      const obj = doc.toObject(); obj.name = name; delete obj._id;
      obj._stats = { ...(obj._stats ?? {}), compendiumSource: `Compendium.${pack.collection}.Item.${id}` };
      const [made] = await actor.createEmbeddedDocuments("Item", [obj]); return made;
    };
    // The three thrown items (their printed damage IS the effect word) …
    const stun   = await fromPack(heavy, "ggK24JleGw0yaQBt", "__PW__Stun Grenade");     // damage "Stun"
    const dazzle = await fromPack(heavy, "kzs0XczTAwo1pgfb", "__PW__Dazzle Grenade");   // damage "Blind"
    const sonic  = await fromPack(heavy, "iN1wBc0bMIf1m7kG", "__PW__Sonic Grenade");    // damage "Deaf"
    // … the tube, and the three module rounds that declare the same words with no dice.
    //
    // ⚠ THE THREE ROUNDS ARE READ FROM `src/packs`, NOT FROM THE COMPILED COMPENDIUM, and that is
    // deliberate rather than a shortcut. `src/packs/**.json` is the TRACKED SOURCE of this module's own
    // pack data; `packs/**` is a gitignored BUILD ARTIFACT whose freshness is a release-process concern
    // (the re-seed gate), not a fact about the mechanism under test. Sourcing the fixture from the
    // artifact would make this suite fail whenever a recompile is merely pending — which it is at the
    // time of writing, the repo recompile being blocked on the live instance — and pass on a stale
    // artifact that happens to be fresh. Foundry serves the module directory statically, so the
    // shipped document is fetched exactly as authored: no fields are hand-typed here.
    const fromSrc = async (file, name) => {
      const res = await fetch(`/modules/cp2020-augmented/src/packs/supplement-heavy/${file}.json`);
      if (!res.ok) return null;
      const obj = await res.json();
      obj.name = name; delete obj._id;
      const [made] = await actor.createEmbeddedDocuments("Item", [obj]);
      return made;
    };
    const tube        = await fromPack(heavy, "u9R4ZnzKOlIFva0o", "__PW__Tube2");
    const stunRound   = await fromSrc("Stun_Grenade_Round_SNoAV2GGfuGY0CuV",   "__PW__Stun Round");
    const dazzleRound = await fromSrc("Dazzle_Grenade_Round_Ks249WPvwlsYBn7m", "__PW__Dazzle Round");
    const sonicRound  = await fromSrc("Sonic_Grenade_Round_FkLhPSOSm1LVVfeI",  "__PW__Sonic Round");
    if (!stun || !dazzle || !sonic || !tube)
      return { fatal: "a base heavy-pack fixture did not resolve from its pack" };
    if (!stunRound || !dazzleRound || !sonicRound)
      return { fatal: "a module grenade round did not resolve from src/packs/supplement-heavy" };
    // A word nothing models — the closed set's negative control.
    const [unknown] = await actor.createEmbeddedDocuments("Item", [
      { name: "__PW__Flash Grenade", type: "weapon", system: { damage: "Flash", ammoType: "Grenade", attackType: "Grenade" } }]);

    const out = { printed: {}, loaded: {}, ladder: {}, fire: {}, payload: {} };
    // DOOR A — the weapon's own printed word.
    out.printed.stun   = ad.wordWarheadOf(stun);
    out.printed.dazzle = ad.wordWarheadOf(dazzle);
    out.printed.sonic  = ad.wordWarheadOf(sonic);
    out.printed.flash  = ad.wordWarheadOf(unknown);
    // The stamped payload fields the consequence is priced off — the corrections layer's own values.
    out.stunModOnItem   = Number(stun._getWeaponSystem?.()?.stunSaveMod ?? stun.system?.stunSaveMod);
    out.dazzleTurnsOnItem = Number(dazzle._getWeaponSystem?.()?.dotTurns ?? dazzle.system?.dotTurns);
    out.sonicTurnsOnItem  = Number(sonic._getWeaponSystem?.()?.dotTurns ?? sonic.system?.dotTurns);

    // DOOR B — a loaded diceless round that declares the word, and the ladder's answer for each.
    const load = async (id) => { await tube.update({ "system.ammoItemId": id }); };
    for (const [name, round] of [["stun", stunRound], ["dazzle", dazzleRound], ["sonic", sonicRound]]) {
      await load(round.id);
      out.loaded[name] = ad.wordWarheadOf(tube);
      out.ladder[name] = await ad.warheadDamageFor(tube);   // ⛔ must be "", never the frag formula
    }

    // The PAYLOAD-side twin, which is what a relayed shot is read through.
    out.payload.stun    = ad.wordWarheadOfPayload({ effectTypes: ["Stun"] });
    out.payload.blind   = ad.wordWarheadOfPayload({ effectTypes: ["Blind"] });
    out.payload.deaf    = ad.wordWarheadOfPayload({ effectTypes: ["Deaf"] });
    out.payload.unknown = ad.wordWarheadOfPayload({ effectTypes: ["Flash"] });
    out.payload.none    = ad.wordWarheadOfPayload({ effectTypes: [] });
    // The hit/miss reading the whole family depends on: a zero-damage card that the base ruled a HIT
    // must NOT read as a miss (that was the defect — a squarely-landed stun grenade scattering).
    out.missZeroHit  = ad.deliveryShotMissed({ baseHit: true,  areaDamages: { Torso: [{ damage: 0 }] } });
    out.missZeroMiss = ad.deliveryShotMissed({ baseHit: false, areaDamages: {} });
    out.missNoVerdict = ad.deliveryShotMissed({ areaDamages: {} });   // the fallback, unchanged

    // ── the fire gesture: all three complete, on the substituted zero ──────────────────────────
    const SENTINEL = "__PW__ROLLED__";
    const fire = async (item) => {
      let seen = null;
      const ret = await actor.sheet._cpFireThroughDamageGuard(item, async () => {
        seen = String(item._getWeaponSystem?.()?.damage ?? item.system?.damage ?? "");
        return SENTINEL;
      });
      return { declined: ret === null, reached: ret === SENTINEL, seen };
    };
    out.fire.stun   = await fire(stun);
    out.fire.dazzle = await fire(dazzle);
    out.fire.sonic  = await fire(sonic);
    out.fire.flash  = await fire(unknown);          // ⛔ still declined — the closed set's refusal
    await load(stunRound.id);
    out.fire.stunTube = await fire(tube);

    await actor.delete().catch(()=>{});
    return out;
  });

  if (R?.fatal) {
    legs.push(["the word-family fixtures resolved from their packs", false, R.fatal]);
  } else {
    legs.push(["admission — the printed word 'Stun' answers Stun", R.printed?.stun === "Stun", String(R.printed?.stun)]);
    legs.push(["admission — the Dazzle item's printed word answers Blind", R.printed?.dazzle === "Blind", String(R.printed?.dazzle)]);
    legs.push(["admission — the Sonic item's printed word answers Deaf", R.printed?.sonic === "Deaf", String(R.printed?.sonic)]);
    legs.push(["admission — a word outside the closed set answers nothing", R.printed?.flash === null, String(R.printed?.flash)]);
    legs.push(["admission — a loaded diceless Stun round answers Stun", R.loaded?.stun === "Stun", String(R.loaded?.stun)]);
    legs.push(["admission — a loaded diceless Dazzle round answers Blind", R.loaded?.dazzle === "Blind", String(R.loaded?.dazzle)]);
    legs.push(["admission — a loaded diceless Sonic round answers Deaf", R.loaded?.sonic === "Deaf", String(R.loaded?.sonic)]);
    legs.push(["ladder — a loaded Stun round answers nothing, never the fragmentation formula", R.ladder?.stun === "", `"${R.ladder?.stun}"`]);
    legs.push(["ladder — a loaded Dazzle round answers nothing, never the fragmentation formula", R.ladder?.dazzle === "", `"${R.ladder?.dazzle}"`]);
    legs.push(["ladder — a loaded Sonic round answers nothing, never the fragmentation formula", R.ladder?.sonic === "", `"${R.ladder?.sonic}"`]);
    legs.push(["payload reader — the three words answer, an unmodelled one and an empty list do not",
      R.payload?.stun === "Stun" && R.payload?.blind === "Blind" && R.payload?.deaf === "Deaf" && R.payload?.unknown === null && R.payload?.none === null,
      JSON.stringify(R.payload)]);
    legs.push(["hit reading — a zero-damage card the base ruled a HIT is not read as a miss", R.missZeroHit === false, String(R.missZeroHit)]);
    legs.push(["hit reading — a card the base ruled a MISS still reads as a miss", R.missZeroMiss === true, String(R.missZeroMiss)]);
    legs.push(["hit reading — a payload stating no verdict falls back to the damage sum", R.missNoVerdict === true, String(R.missNoVerdict)]);
    legs.push(["stamped values — the Stun item carries the book's −5 save penalty", R.stunModOnItem === -5, String(R.stunModOnItem)]);
    legs.push(["stamped values — Dazzle and Sonic each carry the book's 4 turns", R.dazzleTurnsOnItem === 4 && R.sonicTurnsOnItem === 4, `${R.dazzleTurnsOnItem} / ${R.sonicTurnsOnItem}`]);
    legs.push(["fire path — the Stun item is NOT declined and rolls the substituted zero", R.fire?.stun?.reached === true && R.fire?.stun?.seen === "0", JSON.stringify(R.fire?.stun)]);
    legs.push(["fire path — the Dazzle item is NOT declined and rolls the substituted zero", R.fire?.dazzle?.reached === true && R.fire?.dazzle?.seen === "0", JSON.stringify(R.fire?.dazzle)]);
    legs.push(["fire path — the Sonic item is NOT declined and rolls the substituted zero", R.fire?.sonic?.reached === true && R.fire?.sonic?.seen === "0", JSON.stringify(R.fire?.sonic)]);
    legs.push(["fire path — a tube holding the Stun round rolls the substituted zero", R.fire?.stunTube?.reached === true && R.fire?.stunTube?.seen === "0", JSON.stringify(R.fire?.stunTube)]);
    legs.push(["fire path — an unmodelled word is STILL declined (the message, not a silent nothing)", R.fire?.flash?.declined === true, JSON.stringify(R.fire?.flash)]);
  }

  // ── ② the consequence: it lands on exactly the figures the detonation enumerated ──────────────
  //
  // Driven end to end. The Stun leg is raised from the PLAYER's client so the GM-routing relay
  // (`explosionFired`) is exercised for a word payload; the two condition legs are raised on the GM
  // to keep the cadence assertions deterministic. Every leg confirms through the SAME control the
  // frag leg above uses, which is the point: the consequence rides the blast's own enumeration.
  const D = await gm.evaluate(async (d) => {
    const scene = game.scenes.active ?? canvas.scene;
    const inside = game.actors.get(d.npcId);
    // A second body well outside the burst — the negative control for every consequence below.
    const far = await Actor.create({ name: "__PW__Outside", type: "character" });
    const [farTok] = await scene.createEmbeddedDocuments("Token",
      [{ name: far.name, actorId: far.id, actorLink: true, x: 3000, y: 1000, width: 1, height: 1 }]);
    // A combat with the caught figure in it, so the timed conditions have the fight's own clock to
    // count down on (the tick reads combat.combatant — the per-figure cadence the burn engines use).
    for (const c of [...game.combats]) await c.delete().catch(()=>{});
    const combat = await Combat.create({ scene: scene.id });
    await combat.createEmbeddedDocuments("Combatant", [{ tokenId: d.npcTokenId, actorId: d.npcId, initiative: 10 }]);
    let prevTick;
    try { prevTick = game.settings.get("cp2020-augmented","mechRoundTickAutomation"); await game.settings.set("cp2020-augmented","mechRoundTickAutomation",true); } catch(e){}
    return { farId: far.id, farTokenId: farTok.id, combatId: combat.id, prevTick,
             insideStart: Number(inside.system.damage)||0 };
  }, S);
  S.farId = D.farId; S.combatId = D.combatId; S.prevTick = D.prevTick;

  // The shared driver: raise a word payload, wait for the area, press its confirm.
  //
  // ⛔ THE BOARD IS CLEARED FIRST, AND THAT IS LOAD-BEARING (learned the hard way on this suite's own
  // first run): `_confirmExplosion` does not delete the area it resolves, so the frag leg above leaves
  // one standing. A `.pop()` that finds it reports `placed: true` and `confirmed: true` for a shot that
  // in fact placed NOTHING — which is exactly what a red run must not do, since the whole point of
  // these legs is that a zero-damage warhead now places at all. Cleared before, and again after.
  const detonate = async (page, payload) => {
    await gm.evaluate(async () => {
      const scene = game.scenes.active ?? canvas.scene;
      const as = await import("/modules/cp2020-augmented/module/combat/area-shapes.js");
      for (const h of as.areasByFlag(scene, "isExplosion")) await h.doc.delete().catch(() => {});
    });
    await page.evaluate((p) => { Hooks.callAll("cyberpunk2020.weaponFired", p); }, payload);
    return await gm.evaluate(async () => {
      const scene = game.scenes.active ?? canvas.scene;
      const as = await import("/modules/cp2020-augmented/module/combat/area-shapes.js");
      let id = null;
      for (let i = 0; i < 30; i++) { id = as.areasByFlag(scene, "isExplosion").pop()?.doc?.id; if (id) break; await new Promise(r => setTimeout(r, 200)); }
      if (!id) return { placed: false, word: "", confirmed: false };
      const word = as.areasByFlag(scene, "isExplosion").pop()?.doc?.flags?.["cp2020-augmented"]?.wordWarhead ?? "";
      let btn = null;
      for (let i = 0; i < 30; i++) { btn = document.querySelector('.cp-confirm-explosion[data-template-id="' + id + '"]'); if (btn) break; await new Promise(r => setTimeout(r, 200)); }
      if (!btn) return { placed: true, word, confirmed: false };
      btn.click();
      await new Promise(r => setTimeout(r, 1500));
      // Clear the area so the next leg's `.pop()` cannot find a stale one.
      for (const h of as.areasByFlag(scene, "isExplosion")) await h.doc.delete().catch(()=>{});
      return { placed: true, word, confirmed: true };
    });
  };

  // ⚡ STUN — one save at −5 for every figure in the burst, and nobody else. Raised from the PLAYER.
  const stunPayload = { attackerId: S.pcId, targetTokenId: S.npcTokenId, attackType: "Grenade",
    effectTypes: ["Stun"], stunSaveMod: -5, baseHit: true, areaDamages: { Torso: [{ damage: 0 }] },
    weaponName: "PW Grenade Stun" };
  // The frag leg above wounded this same figure and its application posted a stun prompt of its own.
  // Cleared first so the count below is this detonation's alone — the leg asserts EXACTLY ONE save, and
  // an inherited prompt would make that count a coincidence rather than a measurement.
  await gm.evaluate(async () => {
    for (const m of [...game.messages].filter(m => String(m.content || "").includes("cp-stun-save-roll"))) await m.delete().catch(() => {});
  });
  const stunPlaced = await detonate(pl, stunPayload);
  const stunSeen = await gm.evaluate(async (d) => {
    // The prompt names the figure it is asked of, so the two bodies are told apart by name; the
    // penalty is read off the button that will RESOLVE the save, which is the value that decides it.
    const rows = [];
    for (const m of [...game.messages]) {
      const c = String(m.content || "");
      if (!c.includes("cp-stun-save-roll")) continue;
      const el = document.createElement("div"); el.innerHTML = c;
      const btn = el.querySelector(".cp-stun-save-roll");
      rows.push({ actorId: btn?.dataset?.actorId ?? "", saveMod: btn?.dataset?.saveMod ?? "",
                  threshold: (c.match(/≤\s*<b>(-?\d+)<\/b>/) ?? [])[1] ?? "" });
    }
    return { forInside: rows.filter(r => r.actorId === d.npcId), forOutside: rows.filter(r => r.actorId === d.farId) };
  }, { npcId: S.npcId, farId: S.farId });

  legs.push(["stun warhead — the shot PLACED its burst and reached the confirm control", stunPlaced.placed === true && stunPlaced.confirmed === true, JSON.stringify(stunPlaced)]);
  legs.push(["stun warhead — the burst recorded the word it is (relayed from a player's client)", stunPlaced.word === "Stun", String(stunPlaced.word)]);
  legs.push(["stun warhead — EXACTLY ONE save was asked of the figure in the burst", stunSeen.forInside.length === 1, `${stunSeen.forInside.length} prompt(s)`]);
  legs.push(["stun warhead — that save carries the book's −5, on the control that resolves it", stunSeen.forInside[0]?.saveMod === "-5", String(stunSeen.forInside[0]?.saveMod)]);
  legs.push(["stun warhead — the figure OUTSIDE the burst was asked for nothing", stunSeen.forOutside.length === 0, `${stunSeen.forOutside.length} prompt(s)`]);

  // 👁 BLIND (Dazzle) — the timed condition, its status mirror, and its expiry on the fight's clock.
  const blindPlaced = await detonate(gm, { attackerId: S.pcId, targetTokenId: S.npcTokenId, attackType: "Grenade",
    effectTypes: ["Blind"], dotTurns: 4, baseHit: true, areaDamages: { Torso: [{ damage: 0 }] }, weaponName: "PW Grenade Dazzle" });
  const blindOn = await gm.evaluate(async (d) => {
    const read = (id) => { const a = game.actors.get(id);
      const raw = a.getFlag("cp2020-augmented", "wordConditionState");
      return { marks: Array.isArray(raw) ? raw : (raw ? [raw] : []), blind: a.statuses?.has("blind") === true }; };
    for (let i = 0; i < 30; i++) { if (read(d.npcId).marks.length) break; await new Promise(r => setTimeout(r, 200)); }
    return { inside: read(d.npcId), outside: read(d.farId) };
  }, { npcId: S.npcId, farId: S.farId });

  legs.push(["blind warhead — the burst recorded the word it is", blindPlaced.word === "Blind", String(blindPlaced.word)]);
  legs.push(["blind warhead — the figure in the burst carries the marker at the book's 4 turns",
    blindOn.inside?.marks?.length === 1 && blindOn.inside.marks[0]?.word === "Blind" && Number(blindOn.inside.marks[0]?.turnsLeft) === 4,
    JSON.stringify(blindOn.inside?.marks)]);
  legs.push(["blind warhead — the marker raised the core condition the token HUD reads", blindOn.inside?.blind === true, String(blindOn.inside?.blind)]);
  legs.push(["blind warhead — the figure OUTSIDE the burst carries neither marker nor condition",
    blindOn.outside?.marks?.length === 0 && blindOn.outside?.blind === false, JSON.stringify(blindOn.outside)]);

  // The expiry, driven on the REAL combat cadence — one marker turn per round advance, not a timer.
  const decay = await gm.evaluate(async (d) => {
    const combat = game.combats.get(d.combatId);
    const npc = game.actors.get(d.npcId);
    const left = () => { const raw = npc.getFlag("cp2020-augmented", "wordConditionState");
      const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      return Number(arr.find(x => x?.word === "Blind")?.turnsLeft ?? 0); };
    await combat.startCombat();
    await new Promise(r => setTimeout(r, 800));
    const afterStart = left();                 // ⛔ starting the fight is not a turn elapsing
    // ⚠ POLLED, NOT SLEPT. The tick is an async chain of document writes (the decrement, and on the
    // last turn an expiry card and a status toggle as well), so a fixed wait races the longest of them
    // — measured as a trail ending [3,2,1,1] on a run where the fourth tick had simply not landed yet.
    // Each advance waits for the value to actually MOVE, which is the harness's own standing rule.
    const trail = [];
    let want = 4;
    for (let i = 0; i < 4; i++) {
      await combat.nextRound();
      want -= 1;
      for (let w = 0; w < 40 && left() !== want; w++) await new Promise(r => setTimeout(r, 200));
      trail.push(left());
    }
    // The status comes off inside the same tick as the last decrement; give that write its own poll.
    for (let w = 0; w < 25 && npc.statuses?.has("blind"); w++) await new Promise(r => setTimeout(r, 200));
    return { afterStart, trail, blindStill: npc.statuses?.has("blind") === true };
  }, { combatId: S.combatId, npcId: S.npcId });

  legs.push(["blind warhead — starting the encounter does NOT spend a turn of the condition", decay.afterStart === 4, String(decay.afterStart)]);
  legs.push(["blind warhead — the marker counts down one per round and is gone on the fourth", JSON.stringify(decay.trail) === JSON.stringify([3,2,1,0]), JSON.stringify(decay.trail)]);
  legs.push(["blind warhead — the core condition came off with the last marker", decay.blindStill === false, String(decay.blindStill)]);

  // 🔇 DEAF (Sonic) — the other sense, through the LAUNCHER rather than the hand, so the loaded-round
  // route is driven end to end as well as the thrown one.
  const deafPlaced = await detonate(gm, { attackerId: S.pcId, targetTokenId: S.npcTokenId, attackType: "Grenade",
    effectTypes: ["Deaf"], dotTurns: 4, baseHit: true, areaDamages: { Torso: [{ damage: 0 }] }, weaponName: "PW Grenade Sonic" });
  const deafOn = await gm.evaluate(async (d) => {
    const a = game.actors.get(d.npcId);
    for (let i = 0; i < 30; i++) { if (a.statuses?.has("deaf")) break; await new Promise(r => setTimeout(r, 200)); }
    const raw = a.getFlag("cp2020-augmented", "wordConditionState");
    const marks = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const b = game.actors.get(d.farId);
    return { marks, deaf: a.statuses?.has("deaf") === true, outsideDeaf: b.statuses?.has("deaf") === true };
  }, { npcId: S.npcId, farId: S.farId });

  legs.push(["deaf warhead — the burst recorded the word it is", deafPlaced.word === "Deaf", String(deafPlaced.word)]);
  legs.push(["deaf warhead — the figure in the burst carries the marker at the book's 4 turns",
    deafOn.marks?.length === 1 && deafOn.marks[0]?.word === "Deaf" && Number(deafOn.marks[0]?.turnsLeft) === 4, JSON.stringify(deafOn.marks)]);
  legs.push(["deaf warhead — the marker raised the core condition", deafOn.deaf === true, String(deafOn.deaf)]);
  legs.push(["deaf warhead — the figure OUTSIDE the burst carries nothing", deafOn.outsideDeaf === false, String(deafOn.outsideDeaf)]);

  legs.push(["the word-family legs raised no page or console error", errs2.length === 0, errs2.join(" | ") || "none"]);
  armed2 = false;

} catch(e){ log.push("ERROR: "+e.message); legs.push(["the run reached the verdict without throwing", false, e.message]); }
finally {
  if (gm && S) await gm.evaluate(async (d)=>{ const s=game.scenes.active??canvas.scene; const F=(x)=>x.flags?.["cp2020-augmented"]??{}; for(const t of s.tokens.filter(t=>t.name?.startsWith("__PW__"))) await t.delete().catch(()=>{}); for(const coll of [s.templates,s.regions]) if(coll) for(const x of [...coll]) if(F(x).isExplosion||F(x).isGasCloud||F(x).isSpreadZone) await x.delete().catch(()=>{});
    // The encounter this run created for the timed-condition cadence, and its own chat trail.
    for(const c of [...game.combats]) await c.delete().catch(()=>{});
    for(const m of [...game.messages].filter(m=>/__PW__|PW Grenade/.test(m.content||""))) await m.delete().catch(()=>{});
    for(const a of game.actors.filter(a=>a.name?.startsWith("__PW__"))) await a.delete().catch(()=>{}); try{ if(d.prevHead!==undefined) await game.settings.set("cp2020-augmented","headHitDoubling",d.prevHead);}catch(e){} try{ if(d.prevLimb!==undefined) await game.settings.set("cp2020-augmented","limbModel",d.prevLimb);}catch(e){} try{ if(d.prevDetailed!==undefined) await game.settings.set("cp2020-augmented","explosivesDetailed",d.prevDetailed);}catch(e){} try{ if(d.prevTick!==undefined) await game.settings.set("cp2020-augmented","mechRoundTickAutomation",d.prevTick);}catch(e){} }, S).catch(()=>{});
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
