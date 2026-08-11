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

    // ── Migration: a legacy flag-tagged region gains the behavior + loses the flag (no double dose) ──
    const legacy = await makeRegion({ behavior: false, formula: "50", flagLegacy: true });
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
