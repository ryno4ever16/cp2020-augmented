/**
 * ONE hit-location truth: the module's own location rolls resolve on the SAME number→zone map the
 * base engine uses, for every die face, whichever limb-damage model is selected.
 * :30004 (official 1.1.1 + module).
 *
 * The defect this pins: the module carried a SECOND number→zone map (the W4RST4R anatomy chart) and
 * selected it from the limb-damage model setting. The base engine resolves every regular attack on
 * the Core map, so with that model selected the same firefight ran two different anatomies — a
 * suppressive burst or a blast could report a zone the base engine can never produce, and the same
 * forced die face named two different zones depending on which side rolled it.
 *
 * What is asserted (values, not presence):
 *   1. the resolution receipt — where the per-actor map actually lives on a document, and what the
 *      base engine does with an actor that carries a customised one;
 *   2. face-by-face parity with the base engine's own live code, for all ten faces, under each
 *      limb-damage model (⏪ the force-Core switch retired 2026-08-29, settings-trim: the Core map is
 *      pinned in utils.js, so the model is the only dimension left);
 *   3. the absolute Core values too, so parity cannot pass by both sides breaking together;
 *   4. the real suppressive chain end-to-end: the zones the hook payload actually carries;
 *   5. a closed-enumeration guard — the second map is referenced by no file but its own definition,
 *      and every module call site goes through the one shared resolver;
 *   6. the limb-model hint key resolves and says where location tables resolve.
 *
 *   FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node tests/cp2020-augmented-hit-location-truth.mjs
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
  const origUniform = CONFIG.Dice.randomUniform;
  // v13+ DiceTerm.randomFace(): ceil((1 - randomUniform()) * faces). Pin the middle of the band so
  // rounding can never drift the face.
  const forceFace = (f, faces = 10) => { CONFIG.Dice.randomUniform = () => 1 - (f - 0.5) / faces; };
  let prevModel = null;

  try {
    const U  = await import("/modules/cp2020-augmented/module/utils.js");
    const DH = await import("/modules/cp2020-augmented/module/combat/damage-hooks.js");
    const baseUtils = await import("/systems/cyberpunk2020/module/utils.js");
    out.baseVersion = game.system.version;

    prevModel  = game.settings.get(SCOPE, "limbModel");
    // ⏪ the location-table override and the absent-limb re-roll switch both retired 2026-08-29
    //    (settings-trim). The re-roll rule reshapes a location when a limb is gone; the fixtures below
    //    have every limb, so it never fires, and there is nothing left to pin off.

    for (const a of game.actors.filter(a => a.name.startsWith("__PW__HitLoc"))) await a.delete().catch(() => {});
    const plain  = await Actor.create({ name: "__PW__HitLocPlain",  type: "character" });
    const custom = await Actor.create({ name: "__PW__HitLocCustom", type: "character" });
    await sleep(200);

    // ── 1. the resolution receipt ────────────────────────────────────────────────────────────────
    // The base engine reads `targetActor.hitLocLookup`. On a real document that property does not
    // exist — the derived map lives one level down, under `system`. Record both, and record what the
    // base engine therefore answers for an actor whose own map disagrees with the Core one.
    out.docTopLevelLookup = typeof plain.hitLocLookup;         // expect "undefined"
    out.docSystemLookup   = typeof plain.system?.hitLocLookup; // expect "object"

    const hl = foundry.utils.deepClone(custom.system.hitLocations);
    hl.Head.location  = [1, 3];   // faces 1-3 -> Head   (Core map says 2 and 3 are Torso)
    hl.Torso.location = [4, 4];
    await custom.update({ "system.hitLocations": hl });
    await sleep(200);
    out.customActorMap2 = custom.system?.hitLocLookup?.[2] ?? null;   // expect "Head"

    // ── 2/3. face-by-face parity with the base engine's live code ────────────────────────────────
    const CORE_EXPECTED = { 1:"Head", 2:"Torso", 3:"Torso", 4:"Torso", 5:"rArm", 6:"lArm", 7:"lLeg", 8:"lLeg", 9:"rLeg", 10:"rLeg" };
    const faces = [1,2,3,4,5,6,7,8,9,10];

    async function mapFor(rollFn, actor) {
      const m = {};
      for (const f of faces) { forceFace(f); m[f] = (await rollFn(actor, null)).areaHit; }
      CONFIG.Dice.randomUniform = origUniform;
      return m;
    }
    const sameMap = (a, b) => faces.every(f => a[f] === b[f]);
    const isCore  = (m) => faces.every(f => m[f] === CORE_EXPECTED[f]);

    out.baseMapPlain  = await mapFor(baseUtils.rollLocation, plain);
    out.baseMapCustom = await mapFor(baseUtils.rollLocation, custom);
    out.baseMapNoActor = await mapFor(baseUtils.rollLocation, undefined);

    out.matrix = [];
    for (const model of ["core", "listenup", "w4rst4r"]) {
      await game.settings.set(SCOPE, "limbModel", model);
      const modPlain  = await mapFor(U.rollLocation, plain);
      const modCustom = await mapFor(U.rollLocation, custom);
      out.matrix.push({
        model,
        modPlain, modCustom,
        plainMatchesBase:  sameMap(modPlain,  out.baseMapPlain),
        customMatchesBase: sameMap(modCustom, out.baseMapCustom),
        plainIsCore:       isCore(modPlain),
        customIsCore:      isCore(modCustom),
        producesGroin:     faces.some(f => modPlain[f] === "Groin" || modCustom[f] === "Groin"),
      });
    }

    // ── 4. the real suppressive chain ────────────────────────────────────────────────────────────
    // Drive the exported evasion resolver with the model that used to swap the map, on the face that
    // used to produce the zone the base engine cannot make. Read the zones off the payload the hook
    // actually carries, not off the resolver.
    await game.settings.set(SCOPE, "limbModel", "w4rst4r");
    const captured = [];
    const hookId = Hooks.on("cyberpunk2020.weaponFired", (payload) => {
      if (payload?.targetActorId === plain.id) captured.push(Object.keys(payload.areaDamages ?? {}));
    });
    forceFace(10);                       // evasion 1d10 -> 10, hits 1d6 -> 6, location 1d10 -> 10
    try {
      await DH._executeSuppressionEvasion({
        actorId: plain.id, tokenId: null, sceneId: null,
        saveDC: 99,                      // the save cannot be made -> the hit path runs
        dmgFormula: "1d6", attackerId: null,
      });
      await sleep(600);
    } finally { CONFIG.Dice.randomUniform = origUniform; Hooks.off("cyberpunk2020.weaponFired", hookId); }
    out.suppressiveZones = captured.flat();
    out.suppressiveFired = captured.length > 0;

    // ── 5. closed-enumeration guard ──────────────────────────────────────────────────────────────
    // The alternate map must be referenced by nothing but its own definition, and every module site
    // that resolves a location must go through the one shared resolver.
    const files = [
      "module/utils.js", "module/lookups.js",
      "module/combat/damage-hooks.js", "module/combat/DamageApplicator.js",
      "module/vehicle/vehicle-targeting.js",
    ];
    out.altMapRefs = {};
    out.rollSites  = {};
    for (const f of files) {
      const src = await (await fetch(`/modules/cp2020-augmented/${f}`)).text();
      out.altMapRefs[f] = (src.match(/W4RST4R_AREA_LOOKUP/g) || []).length;
      out.rollSites[f]  = (src.match(/rollLocation\(/g) || []).length;
    }

    // ── 6. the honest hint ───────────────────────────────────────────────────────────────────────
    const hintKey = "SETTINGS.LimbModelHint";
    out.hintResolves  = game.i18n.has(hintKey) && game.i18n.localize(hintKey) !== hintKey;
    out.hintText      = game.i18n.localize(hintKey);
    // ⏪ the retired override's own hint key went with it; its name/hint keys must not resolve.
    out.retiredHintGone = game.i18n.has("SETTINGS.HitLocationCoreDisplay") === false
                       && game.i18n.has("SETTINGS.HitLocationCoreDisplayHint") === false;
    out.retiredKeyUnregistered = game.settings.settings.has(`${SCOPE}.hitLocationCoreDisplay`) === false;
    // The honest note, and the removal of the claim it replaces. ⏪ REWORDED 2026-08-29 with the
    //    settings-trim: the hint used to promise Core-side resolution "until the base system's 1.2",
    //    because the alternate chart was waiting on a switch. The switch is gone and the Core map is
    //    pinned, so the shipped sentence is an unconditional statement and the leg reads it as one.
    out.hintSaysCoreSide       = /hit locations?\s+always\s+roll\s+on\s+the\s+Core\s+table/i.test(out.hintText);
    out.hintDropsOwnChartClaim = !/it uses its own hit-location chart/i.test(out.hintText);

    await plain.delete().catch(() => {});
    await custom.delete().catch(() => {});
  } catch (e) { out.err = e?.message || String(e); }
  finally {
    CONFIG.Dice.randomUniform = origUniform;
    try { if (prevModel !== null) await game.settings.set(SCOPE, "limbModel", prevModel); } catch {}
    for (const a of game.actors.filter(a => a.name.startsWith("__PW__HitLoc"))) await a.delete().catch(() => {});
  }
  return out;
});

console.log(JSON.stringify(r, null, 1));

const row = (model) => (r.matrix || []).find(m => m.model === model) || {};
const allRows = r.matrix || [];
const checks = [
  ["receipt: the per-actor map lives under system, not on the document itself",
    r.docTopLevelLookup === "undefined" && r.docSystemLookup === "object"],
  ["receipt: the fixture's own map really does disagree with the Core one on face 2 (Head)",
    r.customActorMap2 === "Head"],
  ["receipt: the base engine answers the Core zone for that actor anyway (face 2 = Torso)",
    r.baseMapCustom?.[2] === "Torso" && r.baseMapPlain?.[2] === "Torso"],

  ["all three limb-damage models were measured", allRows.length === 3],
  ["every model matches the base engine face for face, plain actor",
    allRows.length === 3 && allRows.every(m => m.plainMatchesBase === true)],
  ["every model matches the base engine face for face, actor carrying its own map",
    allRows.length === 3 && allRows.every(m => m.customMatchesBase === true)],
  ["parity is not two engines breaking together: the shared answer IS the Core map",
    allRows.length === 3 && allRows.every(m => m.plainIsCore === true && m.customIsCore === true)],
  ["no model produces a zone the base engine cannot make",
    allRows.length === 3 && allRows.every(m => m.producesGroin === false)],
  ["the model that used to swap the map now answers Core on the telltale faces (2 and 10)",
    row("w4rst4r").modPlain?.[2] === "Torso" && row("w4rst4r").modPlain?.[10] === "rLeg"],

  ["the real suppressive chain fired and carried zones", r.suppressiveFired === true && (r.suppressiveZones || []).length > 0],
  ["the suppressive payload's zones are all Core-map zones",
    (r.suppressiveZones || []).length > 0 &&
    (r.suppressiveZones || []).every(z => ["Head","Torso","rArm","lArm","rLeg","lLeg"].includes(z))],
  ["the suppressive payload carries the forced face's Core zone (rLeg), not the alternate map's",
    (r.suppressiveZones || []).includes("rLeg") && !(r.suppressiveZones || []).includes("Groin")],

  ["the alternate map is referenced only by its own definition file",
    r.altMapRefs && Object.entries(r.altMapRefs).every(([f, n]) => f === "module/lookups.js" ? n >= 1 : n === 0)],
  ["the three module call sites still resolve through the one shared helper",
    r.rollSites?.["module/combat/damage-hooks.js"] === 2 &&
    r.rollSites?.["module/vehicle/vehicle-targeting.js"] === 1],

  ["the limb-model hint key resolves", r.hintResolves === true],
  ["the hint states, unconditionally, that location rolls use the Core table", r.hintSaysCoreSide === true],
  // ⏪ leg retired 2026-08-29 with its switch (settings-trim): "the hint names what the alternate
  //    chart is waiting on (base system 1.2)" described a deferral that the pinning ended.
  ["the hint no longer claims the model brings its own chart", r.hintDropsOwnChartClaim === true],
  // ⏪ off-state leg retired 2026-08-29 with its switch (settings-trim): the neighbouring override's
  //    hint cannot advertise anything because the override is gone. Its absence is asserted instead.
  ["the retired location-table override is unregistered", r.retiredKeyUnregistered === true],
  ["and its name/hint keys are gone with it", r.retiredHintGone === true],

  ["no unexpected error in the probe", !r.err],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
console.log(`${checks.length - fail}/${checks.length}`);
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
