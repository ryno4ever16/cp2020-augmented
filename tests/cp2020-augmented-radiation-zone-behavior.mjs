/** Radiation Zone as a native Region Behavior (module/radiation/radiation-zone-behavior.js +
 *  the region-lookup tick in radiation-zones.js). On :30004 (v14) and :30003 (v13):
 *   - the custom behavior TYPE registers (two-part: module.json documentTypes + init CONFIG) and a
 *     RegionBehavior of that type can actually be created on a Region;
 *   - a token standing in a Region carrying an enabled behavior is dosed by the per-round tick, and a
 *     token OUTSIDE it (or in a region WITHOUT the behavior) is not;
 *   - a fresh rad-zone region is auto-bumped to GM-visible (players don't see it, GM does in play);
 *   - a legacy `isRadZone`-flagged region migrates to the behavior and drops the flag (no double dose).
 *  Uses a fixed rads formula so dosing is deterministic; proves a dose by diffing the actor's module
 *  flags. Needs the module SYNCED to the rig AND the rig Foundry server RESTARTED (module.json changed →
 *  the RegionBehavior type is only valid after a server reload). All fixtures self-clean. */
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

const r = await p.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = { checks: [], fails: [] };
  const check = (n, ok, got) => { out.checks.push(`${ok?"  PASS":"  FAIL"}  ${n}${ok?"":"  got="+JSON.stringify(got)}`); if(!ok) out.fails.push(n); };
  const SCOPE = "cp2020-augmented";
  const T = "cp2020-augmented.radiationZone";
  const BE = await import("/modules/cp2020-augmented/module/radiation/radiation-zone-behavior.js");
  const RZ = await import("/modules/cp2020-augmented/module/radiation/radiation-zones.js");

  // Deterministic rectangle region covering a known pixel box; token placed at its centre.
  const BOX = { x: 2000, y: 2000, w: 800, h: 800 };
  const inside = { x: BOX.x + BOX.w/2, y: BOX.y + BOX.h/2 };
  const outside = { x: BOX.x + BOX.w + 600, y: BOX.y };
  // A SEPARATE, far-away box for the no-behavior negative case, so it can't overlap the rad-zone region
  // created above (which would dose the "plain" token and mask the real behaviour).
  const PLAIN_BOX = { x: 6000, y: 6000, w: 800, h: 800 };
  const plainInside = { x: PLAIN_BOX.x + PLAIN_BOX.w/2, y: PLAIN_BOX.y + PLAIN_BOX.h/2 };
  const rectShape = (box = BOX) => ({ type: "rectangle", x: box.x, y: box.y, width: box.w, height: box.h, hole: false, rotation: 0 });
  const flagsSnap = (a) => JSON.stringify(a.flags?.[SCOPE] ?? {});
  const madeActors = [], madeRegions = [];

  try {
    const scene = canvas?.scene;
    if (!scene) { check("active scene present", false, null); return out; }
    check("active scene present", !!scene, null);

    // ── Registration (proves the two-part manifest+CONFIG registration + server restart) ──
    check("behavior TYPE registered in CONFIG.RegionBehavior.dataModels", typeof CONFIG.RegionBehavior?.dataModels?.[T] === "function", typeof CONFIG.RegionBehavior?.dataModels?.[T]);
    check("behaviorClass() resolves", typeof BE.radiationZoneBehaviorClass() === "function", null);
    check("RAD_ZONE_BEHAVIOR const", BE.RAD_ZONE_BEHAVIOR === T, BE.RAD_ZONE_BEHAVIOR);

    // Helper: make a region with an optional rad-zone behavior; returns the RegionDocument.
    // The behavior is added in a SECOND step (region first, then RegionBehavior) to mirror the real GM
    // gesture — draw a region, then add a behavior to it. Foundry only fires `createRegionBehavior` for a
    // behavior created on an existing region, NOT for one embedded inline in the parent Region's own
    // creation (rig-proven on v14); the visibility auto-bump keys off that hook, so a behavior added inline
    // would never trigger it. Adding it after create exercises the code path the feature actually uses.
    const makeRegion = async ({ behavior = true, formula = "100", flagLegacy = false, box = BOX } = {}) => {
      const data = { name: "__PW__RadRegion", shapes: [rectShape(box)], behaviors: [] };
      if (flagLegacy) data.flags = { [SCOPE]: { isRadZone: true, radsFormula: formula, sourceLabel: "Legacy", turnsLeft: 5, createdRound: 2 } };
      const [reg] = await scene.createEmbeddedDocuments("Region", [data]);
      madeRegions.push(reg.id);
      if (behavior) {
        await reg.createEmbeddedDocuments("RegionBehavior", [{ name: "Radiation Zone", type: T, system: { radsFormula: formula, sourceLabel: "Probe" } }]);
      }
      return reg;
    };

    // Real proof the type is VALID (invalid types are silently dropped at create).
    const reg = await makeRegion({ behavior: true, formula: "100" });
    check("Region CREATED with a rad-zone behavior (type accepted)", reg?.behaviors?.some(x => x.type === T), reg?.behaviors?.map(x=>x.type));

    // ── Visibility auto-bump: the createRegionBehavior hook nudges a layer-default region to GAMEMASTER ──
    for (let i=0;i<20 && reg.visibility !== (CONST.REGION_VISIBILITY.GAMEMASTER ?? 1); i++) await sleep(150);
    check("fresh rad-zone region auto-set to GAMEMASTER visibility (GM sees, players don't)", reg.visibility === (CONST.REGION_VISIBILITY.GAMEMASTER ?? 1), reg.visibility);

    // ── Positive dose: a token inside the region is dosed by the tick ──
    const aIn = await Actor.create({ name: "__PW__RadInside", type: "character" }); madeActors.push(aIn.id);
    const [tIn] = await scene.createEmbeddedDocuments("Token", [{ name: aIn.name, actorId: aIn.id, actorLink: true, x: inside.x - 50, y: inside.y - 50, width: 1, height: 1 }]);
    // Let the region layer register the token as inside (region.tokens is canvas-maintained).
    for (let i=0;i<25 && !(reg.tokens?.size); i++) await sleep(150);
    check("region.tokens reports the inside token", (reg.tokens?.size ?? 0) >= 1, reg.tokens?.size);
    const beforeIn = flagsSnap(aIn);
    await RZ.runRadZoneTick({ round: 1 });
    await sleep(400);
    check("POSITIVE: token inside a rad-zone region is dosed (module flags changed)", flagsSnap(aIn) !== beforeIn, { before: beforeIn, after: flagsSnap(aIn) });

    // ── Negative: a token OUTSIDE the region is not dosed ──
    const aOut = await Actor.create({ name: "__PW__RadOutside", type: "character" }); madeActors.push(aOut.id);
    await scene.createEmbeddedDocuments("Token", [{ name: aOut.name, actorId: aOut.id, actorLink: true, x: outside.x, y: outside.y, width: 1, height: 1 }]);
    await sleep(600);
    const beforeOut = flagsSnap(aOut);
    await RZ.runRadZoneTick({ round: 2 });
    await sleep(400);
    check("NEGATIVE: token outside the region is NOT dosed", flagsSnap(aOut) === beforeOut, { before: beforeOut, after: flagsSnap(aOut) });

    // ── Negative: a region WITHOUT the behavior doses nobody ──
    // Placed on its OWN far box (PLAIN_BOX), clear of the rad-zone region above — otherwise the token would
    // be standing inside BOTH regions and the rad zone would dose it, masking the no-behavior case.
    const plainReg = await makeRegion({ behavior: false, box: PLAIN_BOX });
    const aPlain = await Actor.create({ name: "__PW__RadNoBehavior", type: "character" }); madeActors.push(aPlain.id);
    await scene.createEmbeddedDocuments("Token", [{ name: aPlain.name, actorId: aPlain.id, actorLink: true, x: plainInside.x - 50, y: plainInside.y - 50, width: 1, height: 1 }]);
    for (let i=0;i<20 && !(plainReg.tokens?.size); i++) await sleep(150);
    const beforePlain = flagsSnap(aPlain);
    await RZ.runRadZoneTick({ round: 3 });
    await sleep(400);
    check("NEGATIVE: a region without the behavior doses nobody", flagsSnap(aPlain) === beforePlain, { before: beforePlain, after: flagsSnap(aPlain) });

    // ══ ENTRY FEEDBACK (2026-08-13) ═══════════════════════════════════════════════════════════
    // A token entering a rad field used to say NOTHING until a combat round elapsed — and out of
    // combat, nothing ever, because the dosing rides the round-advance sweep. Reported from live play
    // as the feature being dead. Every leg below reads the REAL chat log the cue posts into.
    //
    // ⚠ ENTRY IS DRIVEN BY CREATING THE FIGURE INSIDE, NOT BY WALKING IT IN, and that is a rig
    // constraint rather than a narrowing of the feature. TOKEN_ENTER fires for four documented ways a
    // token comes to be inside a region (see the behavior's `static events` note); this drives the
    // CREATED-INSIDE one — the "drop four corpsec into the reactor room" case, and precisely the case
    // TOKEN_MOVE_IN would have missed. The walked-in case rides the same single event and could not be
    // driven here: programmatic position updates on this core are collision-constrained, and the scene
    // this suite runs on is the cover review scene, which is full of walls (measured: a move request
    // from outside the box to its centre left the figure where it started, under three different
    // update forms including the displace waypoint).
    // ⚠ NAMES THAT DO NOT PREFIX ONE ANOTHER. These filters are substring matches, so a fixture called
    // "…Walker" and one called "…Walker2" are indistinguishable to them — which is exactly how the
    // in-combat entrant's cue got counted against the out-of-combat leg. Alpha / Beta / Gamma share no
    // prefix.
    // And a PRE-SWEEP: a run that dies before its own teardown leaves its cards in the log, and the
    // first leg here is a "nothing has happened yet" negative that would read them as this run's.
    for (const m of [...game.messages].filter(m => /__PW__Rad(Alpha|Beta|Gamma)/.test(m.content ?? ""))) {
      try { await m.delete(); } catch (e) { /* gone */ }
    }
    const anyCardNaming = () => [...game.messages].filter(m => (m.content ?? "").includes("__PW__RadAlpha"));
    // ⚠ MATCH THE CUE, NOT THE NAME. The per-round tick posts its OWN card naming whoever suffered an
    // effect, and at 100 rads a round this figure does — so a filter on the token name alone would count
    // a dosing card as an entry cue and the "the tick does not re-fire the cue" leg would measure
    // nothing. The cue is identified by the sentence only it carries.
    const radCards = () => anyCardNaming().filter(m => /each combat round/i.test(m.content ?? ""));
    const waitCards = async (n, tries = 40) => {
      for (let i = 0; i < tries && radCards().length < n; i++) await sleep(200);
      return radCards();
    };

    // NEGATIVE first: a figure created OUTSIDE the zone raises nothing at all.
    const aOutside = await Actor.create({ name: "__PW__RadGamma", type: "character" }); madeActors.push(aOutside.id);
    await scene.createEmbeddedDocuments("Token", [{
      name: aOutside.name, actorId: aOutside.id, actorLink: true,
      x: outside.x, y: outside.y + 400, width: 1, height: 1,
    }]);
    await sleep(900);
    check("NEGATIVE: a figure that appears outside the zone raises no cue",
      anyCardNaming().length === 0, anyCardNaming().length);

    // ── out of combat: the cue must fire, because no round will ever elapse to speak for it ──
    const aWalk = await Actor.create({ name: "__PW__RadAlpha", type: "character" }); madeActors.push(aWalk.id);
    const beforeWalk = flagsSnap(aWalk);
    const [tWalk] = await scene.createEmbeddedDocuments("Token", [{
      name: aWalk.name, actorId: aWalk.id, actorLink: true,
      x: inside.x - 50, y: inside.y - 50, width: 1, height: 1,
    }]);
    const outOfCombat = await waitCards(1);
    check("ENTRY (out of combat): entering posts a cue — the case that was silent forever",
      outOfCombat.length === 1, outOfCombat.length);
    const cueText = (outOfCombat[0]?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    check("the cue names the token, the zone's own label, and the rads formula",
      /__PW__RadAlpha/.test(cueText) && /Probe/.test(cueText) && /100/.test(cueText), cueText.slice(0, 200));
    check("the cue says WHEN it doses, so a GM is not left waiting on nothing",
      /each combat round/i.test(cueText), cueText.slice(0, 200));
    check("the cue leaks no raw i18n key", !/CYBERPUNK\./.test(outOfCombat[0]?.content ?? ""), cueText.slice(0, 120));
    // ⛔ GM-ONLY, concretely: the recipient list IS the GM ids, not "probably hidden".
    const gmIds = (globalThis.ChatMessage?.getWhisperRecipients?.("GM") ?? []).map(u => u.id).sort();
    const cueWhisper = [...(outOfCombat[0]?.whisper ?? [])].sort();
    check("the cue is whispered to exactly the GM ids (players are not told they are irradiated)",
      gmIds.length > 0 && JSON.stringify(cueWhisper) === JSON.stringify(gmIds),
      { whisper: cueWhisper, gmIds });
    check("NEGATIVE: entering did not itself dose anybody — the cue is a notice, not a tick",
      flagsSnap(aWalk) === beforeWalk, { before: beforeWalk, after: flagsSnap(aWalk) });

    // ── the ROUND-TICK path itself, driven as the real gesture ──────────────────────────────────
    // ⛔ NOT `runRadZoneTick()` — that is the leg further up. The user's report was "nothing happened"
    // in PLAY, so this drives the shipped road: a real Combat, a real round advance, on the active GM,
    // through the updateCombat hook. If this is red the feature is broken where it matters.
    let combat = null;
    let tickWas;
    try {
      // The round-tick MASTER gates this whole path (_hookRadZonePerTurn's first line). A rig with it
      // off would make the dosing leg red for a reason that is a setting, not a defect.
      try {
        tickWas = game.settings.get(SCOPE, "mechRoundTickAutomation");
        if (tickWas === false) await game.settings.set(SCOPE, "mechRoundTickAutomation", true);
      } catch (e) { /* key absent on this build — mechRoundTickEnabled() then defaults to on */ }

      for (let i = 0; i < 40 && ![...(reg.tokens ?? [])].some(t => t.id === tWalk.id); i++) await sleep(200);
      check("the region registers the figure before the round is advanced",
        [...(reg.tokens ?? [])].some(t => t.id === tWalk.id), [...(reg.tokens ?? [])].map(t => t.name));

      combat = await Combat.create({ scene: scene.id });
      await combat.createEmbeddedDocuments("Combatant", [{ tokenId: tWalk.id, actorId: aWalk.id }]);
      await combat.activate();
      await combat.startCombat();
      await sleep(600);
      const beforeRound = flagsSnap(aWalk);
      const cardsBeforeRound = radCards().length;
      await combat.update({ round: (Number(combat.round) || 1) + 1, turn: 0 });
      // The hook chain is async (roll → applyRadiationDose → flag writes).
      // ⚠ WAIT FOR BOTH WRITES. applyRadiationDose sets radExposure and radHistory as two sequential
      // flag writes; a poll that wakes on "the flags changed at all" reads between them and sees the
      // second as null (measured on v13). Poll for the pair.
      for (let i = 0; i < 60 && !(Number.isFinite(Number(aWalk.getFlag(SCOPE, "radExposure")))
        && Number.isFinite(Number(aWalk.getFlag(SCOPE, "radHistory")))); i++) await sleep(250);
      check("ROUND TICK: advancing a real combat round doses the figure inside the zone",
        flagsSnap(aWalk) !== beforeRound, { before: beforeRound, after: flagsSnap(aWalk) });
      // The dose surface: `radExposure` is the current exposure's cumulative rads (what the effects
      // table keys on), `radHistory` is lifetime. One round of a fixed "100" formula = exactly 100 on a
      // figure that started clean, with no RSP subtraction because nothing is worn.
      const exposure = Number(aWalk.getFlag(SCOPE, "radExposure") ?? NaN);
      const history = Number(aWalk.getFlag(SCOPE, "radHistory") ?? NaN);
      check("ROUND TICK: the dose is the zone's own formula, by value (100 rads in one round)",
        exposure === 100 && history === 100, { radExposure: exposure, radHistory: history, formula: "100" });
      check("ROUND TICK: the round advance did not re-fire the entry cue (a notice, not a heartbeat)",
        radCards().length === cardsBeforeRound, { before: cardsBeforeRound, after: radCards().length });

      // ── entry DURING combat raises the cue too ──
      const aJoin = await Actor.create({ name: "__PW__RadBeta", type: "character" }); madeActors.push(aJoin.id);
      const joinCards = () => [...game.messages].filter(m => (m.content ?? "").includes("__PW__RadBeta")
        && /each combat round/i.test(m.content ?? ""));
      await scene.createEmbeddedDocuments("Token", [{
        name: aJoin.name, actorId: aJoin.id, actorLink: true,
        x: inside.x + 50, y: inside.y + 50, width: 1, height: 1,
      }]);
      for (let i = 0; i < 40 && joinCards().length < 1; i++) await sleep(200);
      check("ENTRY (in combat): entering during a fight posts the cue as well",
        joinCards().length === 1, joinCards().length);
    } finally {
      try { if (combat) await combat.delete(); } catch (e) { /* gone */ }
      try { if (tickWas === false) await game.settings.set(SCOPE, "mechRoundTickAutomation", false); } catch (e) { /* not set */ }
      // Every fixture's cards, not just the first one's — Beta's in-combat cue lives here too.
      for (const m of [...game.messages].filter(m => /__PW__Rad(Alpha|Beta|Gamma)/.test(m.content ?? ""))) {
        try { await m.delete(); } catch (e) { /* gone */ }
      }
    }

    // ── Migration: a legacy flag-tagged region gains the behavior + loses the flag (no double dose) ──
    // On its OWN box: this region gains a rad-zone behavior when it migrates, and a behavior becoming
    // active raises TOKEN_ENTER for everyone already inside it (one of the four documented entry
    // cases). Sharing BOX with the live zone therefore re-cued every entry fixture still standing
    // there — correct behaviour, counted as noise by the legs above.
    const LEGACY_BOX = { x: 9000, y: 9000, w: 800, h: 800 };
    const legacy = await makeRegion({ behavior: false, formula: "50", flagLegacy: true, box: LEGACY_BOX });
    check("legacy region starts with the isRadZone flag, no behavior", !!legacy.flags?.[SCOPE]?.isRadZone && !legacy.behaviors?.some(x=>x.type===T), null);
    // The pass carries a world completion stamp (it is a one-time upgrade, not a per-boot sweep), so a
    // fixture placed after that stamp is picked up through the same `force` the module api exposes.
    await RZ.migrateLegacyRadZones({ force: true });
    await sleep(500);
    check("MIGRATION: legacy region now carries the behavior", legacy.behaviors?.some(x => x.type === T), legacy.behaviors?.map(x=>x.type));
    check("MIGRATION: legacy isRadZone flag removed (prevents double-dose)", !legacy.flags?.[SCOPE]?.isRadZone, legacy.flags?.[SCOPE]);
    check("MIGRATION: orphan data flags removed (radsFormula/sourceLabel/turnsLeft/createdRound)",
      legacy.flags?.[SCOPE]?.radsFormula === undefined && legacy.flags?.[SCOPE]?.sourceLabel === undefined
      && legacy.flags?.[SCOPE]?.turnsLeft === undefined && legacy.flags?.[SCOPE]?.createdRound === undefined,
      legacy.flags?.[SCOPE]);
  } catch (e) {
    check("no exception during the run", false, String(e?.message ?? e));
  } finally {
    for (const id of madeRegions) await canvas?.scene?.deleteEmbeddedDocuments?.("Region", [id]).catch(()=>{});
    // Tokens BEFORE actors. This pass used to drop the actors and leave their tokens standing — deleting a
    // linked actor does not remove its token document — so every run left three orphan tokens on whatever
    // scene was active, which is exactly the dangling-token litter this rig has had to be swept for.
    const strayTokenIds = [...(canvas?.scene?.tokens ?? [])].filter(t => t.name?.startsWith("__PW__Rad")).map(t => t.id);
    if (strayTokenIds.length) await canvas?.scene?.deleteEmbeddedDocuments?.("Token", strayTokenIds).catch(()=>{});
    for (const a of game.actors.filter(a => a.name.startsWith("__PW__Rad"))) await a.delete().catch(()=>{});
  }
  return out;
});

for (const line of r.checks) console.log(line);
const errOk = errors.length === 0;
console.log(`${errOk?"  PASS":"  FAIL"}  0 console errors${errOk?"":"  got="+JSON.stringify(errors.slice(0,6))}`);
const failed = r.fails.length + (errOk ? 0 : 1);
console.log(`\n${r.checks.length + 1} checks, ${failed} failed`);
await b.close();
process.exit(failed ? 1 : 0);
