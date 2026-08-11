/** Cybereye-showcase provisioner runner: executes the provisioning macro on the rig, then views
 *  each showcase scene and asserts every token's sight override matches its device configuration
 *  (mode resolution, range, heat-sense entry, UV illuminator gate, picker legs). */
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const MACRO = "C:/Users/randa/AppData/Local/FoundryVTT/Data/modules/cp2020-augmented/import-staging/test-fixtures/provision-cybereye-showcase.js";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const src = readFileSync(MACRO, "utf-8");

// 1) token-writes gate must be ON for the engine to drive sight at all
await p.evaluate(async () => { await game.settings.set("cp2020-augmented", "mechTokenWrites", true).catch(() => {}); });

// 2) provision
const prov = await p.evaluate(async (code) => await eval(code), src);
if (!prov?.actors || !prov?.scenes) { console.log("RESULT: FAIL — provisioner returned", JSON.stringify(prov)); process.exit(1); }
console.log("provisioned:", JSON.stringify(prov.notes));

// 3) per-scene verification
const r = await p.evaluate(async (prov) => {
  const out = { checks: [], fails: [] };
  const V = await import("/modules/cp2020-augmented/module/mech/vision.js");
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const A = id => game.actors.get(prov.actors[id]);
  const check = (label, ok, detail = "") => { out.checks.push(`${ok ? "PASS" : "FAIL"} ${label}${detail ? " — " + detail : ""}`); if (!ok) out.fails.push(label); };

  async function viewScene(id) {
    // let any in-flight token animations on the outgoing scene finish before tearing it down
    // (headless: a mid-animation scene switch throws core RenderFlags/addChild frame errors)
    await sleep(1500);
    const sc = game.scenes.get(id);
    await sc.view();
    for (let i = 0; i < 100 && !(canvas.ready && canvas.scene?.id === id); i++) await sleep(150);
    await sleep(1500);
    return sc;
  }
  const tokOf = (sc, actorKey, nth = 0) => sc.tokens.filter(t => t.actorId === prov.actors[actorKey])[nth];
  const sightOf = t => ({
    mode: t.sight.visionMode, range: t.sight.range,
    overridden: t.getFlag("cp2020-augmented", "mechBaseSight") !== undefined,
    heat: !!t._source.detectionModes?.cpHeatSense?.enabled,
    heatRange: t._source.detectionModes?.cpHeatSense?.range
  });
  async function untilSight(t, pred) { for (let i = 0; i < 60; i++) { if (pred(sightOf(t))) return true; await sleep(200); } return pred(sightOf(t)); }

  const EXP = {
    lowlight: V.resolveVisionMode("lowlight"), infrared: V.resolveVisionMode("infrared"),
    thermograph: V.resolveVisionMode("thermograph"), uv: V.resolveVisionMode("uv"),
    echolocation: V.resolveVisionMode("echolocation")
  };
  out.resolved = EXP;

  // living gate (pure, render-side visibility is the user's eyes)
  check("warm body counts as living", V.isLivingActor(A("warm")) === true);
  check("mannequin flagged unliving", V.isLivingActor(A("cold")) === false);

  // — Scene 1: Dark Street —
  const s1 = await viewScene(prov.scenes.darkStreet);
  await untilSight(tokOf(s1, "infrared"), s => s.heat);   // reconcile settle marker
  let s = sightOf(tokOf(s1, "natural"));
  check("S1 natural: untouched", !s.overridden && !s.heat, JSON.stringify(s));
  s = sightOf(tokOf(s1, "lowlite"));
  check("S1 low-lite: amplification, no heat", s.overridden && s.mode === EXP.lowlight && s.range === 20 && !s.heat, JSON.stringify(s));
  s = sightOf(tokOf(s1, "infrared"));
  check("S1 infrared: heat-only (twin of thermograph), no sight radius", s.overridden && s.mode === EXP.infrared && s.range === 0 && s.heat && s.heatRange === 20, JSON.stringify(s));
  s = sightOf(tokOf(s1, "thermo"));
  check("S1 thermograph: heat only, no darkness-sight radius", s.overridden && s.mode === EXP.thermograph && s.heat && s.range === 0 && s.heatRange === 20, JSON.stringify(s));
  s = sightOf(tokOf(s1, "uvBare"));
  check("S1 UV w/o illuminator: stays natural", !s.overridden && !s.heat, JSON.stringify(s));
  s = sightOf(tokOf(s1, "uvLit"));
  check("S1 UV + IR Flash: governs, no heat", s.overridden && s.mode === EXP.uv && !s.heat, JSON.stringify(s));

  // — Scene 2: Pitch-Black Tunnel —
  const s2 = await viewScene(prov.scenes.tunnel);
  await untilSight(tokOf(s2, "echo"), x => x.overridden);
  s = sightOf(tokOf(s2, "echo"));
  check("S2 echolocation: dark sight, no heat", s.overridden && s.mode === EXP.echolocation && !s.heat, JSON.stringify(s));
  s = sightOf(tokOf(s2, "infrared"));
  check("S2 infrared token overridden here too", s.overridden && s.heat, JSON.stringify(s));
  check("S2 wall present for heat blocking", s2.walls.size === 1);
  check("S2 two warm-body tokens placed", s2.tokens.filter(t => t.actorId === prov.actors.warm).length === 2);

  // — Scene 3: Borg Optics & Picker —
  const s3 = await viewScene(prov.scenes.borg);
  const multiTok = tokOf(s3, "multi");
  await untilSight(multiTok, x => x.overridden && x.heat);
  s = sightOf(multiTok);
  check("S3 multi auto: IR (device range 30) governs, heat-only", s.overridden && s.range === 0 && s.heatRange === 30 && s.heat && s.mode === EXP.infrared, JSON.stringify(s));

  const borgTok = tokOf(s3, "borg");
  const borgOptics = A("borg").items.filter(i => i.system?.mechVision?.enabled);
  check("S3 borg materialized 3 vision optics", borgOptics.length === 3, borgOptics.map(i => i.name).join(", "));
  await untilSight(borgTok, x => x.overridden);
  s = sightOf(borgTok);
  check("S3 borg governed (tie → infrared, heat on)", s.overridden && s.heat && s.mode === EXP.infrared, JSON.stringify(s));

  // picker legs on the multi-optic human
  const multiA = A("multi");
  const lowItem = multiA.items.find(i => i.system?.mechVision?.mode === "lowlight");
  await multiA.setFlag("cp2020-augmented", "visionPick", lowItem.id);
  check("picker: chosen device governs", await untilSight(multiTok, x => x.mode === EXP.lowlight && x.range === 20 && !x.heat), JSON.stringify(sightOf(multiTok)));
  await multiA.setFlag("cp2020-augmented", "visionPick", "natural");
  check("picker: Natural suspends override", await untilSight(multiTok, x => !x.overridden && !x.heat), JSON.stringify(sightOf(multiTok)));
  await multiA.unsetFlag("cp2020-augmented", "visionPick");
  check("picker: back to auto (IR heat, device range 30)", await untilSight(multiTok, x => x.overridden && x.heat && x.heatRange === 30 && x.range === 0), JSON.stringify(sightOf(multiTok)));

  return out;
}, prov);

for (const line of r.checks) console.log(line);
console.log("resolved modes on this core:", JSON.stringify(r.resolved));
const errs = errors.filter(e => !/screen resolution/i.test(e));
if (errs.length) console.log("page errors:", errs.join(" | "));
const pass = r.fails.length === 0 && errs.length === 0;
console.log(`RESULT: ${pass ? "PASS" : "FAIL"} ${r.checks.length - r.fails.length}/${r.checks.length}`);
await b.close();
process.exit(pass ? 0 : 1);
