/** MM-feedback batch (Seb + FBC drug feedback, 2026-07-11). Two units:
 *  (1) ACPA expanded multi-action penalty + ½-REF action cap (MM p.54) — pure helpers in damage-hooks.js.
 *  (2) FBC drug restriction — a full-conversion cyborg's chassis-set physical stats (REF/MA/BODY) ignore
 *      drug boosts; the advisory fires only when a boost is actually ignored (drug.js).
 *  Runs on :30004 (1.1.1 + module). Mirrors cp2020-augmented-radiation-tools.mjs. */
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
  const out = {};
  const DH = await import("/modules/cp2020-augmented/module/combat/damage-hooks.js");
  const DRUG = await import("/modules/cp2020-augmented/module/mech/drug.js");
  const SCOPE = "cp2020-augmented";
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__MMF"))) await a.delete().catch(() => {});

  try {
    // ── (1) ACPA multi-action penalty (pure) ──────────────────────────────────
    const acpa = { system: { isACPA: true, effectiveRef: 10 } };
    const grunt = { system: {} };
    out.penaltyAcpa  = [1, 2, 3, 4, 5].map(n => DH._multiActionPenaltyFor(acpa, n));   // 0,-3,-4,-5,-6
    out.penaltyGrunt = [1, 2, 3, 4, 5].map(n => DH._multiActionPenaltyFor(grunt, n));   // 0,-3,-6,-9,-12
    out.isAcpa = [DH._isAcpa(acpa), DH._isAcpa(grunt)];                                  // true,false
    out.maxActions = [10, 9, 7, 2, 1, 0].map(ref => DH._acpaMaxActions({ system: { effectiveRef: ref } }));
    // floor(ref/2), min 1 → 5,4,3,1,1,1

    // ── (2) FBC drug restriction ──────────────────────────────────────────────
    // pure: which drugs target a chassis-set stat
    out.setStats = ["ref", "ma", "bt"].every(s => DRUG.FBC_SET_STATS.has(s)) && !DRUG.FBC_SET_STATS.has("cool");
    out.affectsSet = {
      ref:  DRUG.drugAffectsSetStat({ statBoosts: [{ stat: "ref", mod: 2 }] }),       // true
      body: DRUG.drugAffectsSetStat({ statBoosts: [{ stat: "bt",  mod: 2 }] }),       // true
      cool: DRUG.drugAffectsSetStat({ statBoosts: [{ stat: "cool", mod: 2 }] }),      // false
      mixed: DRUG.drugAffectsSetStat({ statBoosts: [{ stat: "cool", mod: 1 }, { stat: "ma", mod: 1 }] }), // true
    };

    // live overlay: a full borg's REF drug boost is dropped; COOL still applies. Control: a normal
    // character keeps both. Assert on _mechDrugMods (the per-stat contribution map applyMechDrugBoosts writes).
    const marker = () => [{ name: "__PW__MMFDrug", statBoosts: [{ stat: "ref", mod: 3 }, { stat: "cool", mod: 2 }], turnsLeft: 5 }];

    const borg = await Actor.create({ name: "__PW__MMFBorg", type: "character" });
    // B3.12 refinement (2026-07-11): the FBC drug-skip gates on borgSetStatKeys — the stats the CHASSIS
    // actually SETS — not on isFullBorg alone. A bare fullBorg flag (no body stats block) leaves the
    // physical stats on the meat value, so a drug still moves them. Use a body item WITH a stats block so
    // the chassis genuinely SETS REF (borgSetStatKeys has "ref") → the REF boost is correctly dropped.
    await borg.createEmbeddedDocuments("Item", [{
      name: "__PW__MMFBody", type: "cyberware",
      system: { equipped: true, EffectMode: "Permanent" },
      flags: { "cp2020-augmented": { borgBody: {
        sdp: { Head: 30, Torso: 40, lArm: 30, rArm: 30, lLeg: 30, rLeg: 30 },
        stats: { ref: 14, ma: 10, body: 12 } } } }
    }]);
    await borg.setFlag(SCOPE, "drugState", marker());
    for (let i = 0; i < 20 && (Number(borg.system?.stats?.ref?.total) || 0) !== 14; i++) await sleep(150);
    const bm = borg._mechDrugMods || {};
    out.borgDrug = {
      isFullBorg: (await import("/modules/cp2020-augmented/module/mech/borg.js")).isFullBorg(borg),  // true
      refDropped: !("ref" in bm),      // true — chassis-set stat (stats block SETs REF), boost ignored
      coolApplied: "cool" in bm,       // true — non-physical, boost applies
    };

    const norm = await Actor.create({ name: "__PW__MMFNorm", type: "character" });
    await norm.setFlag(SCOPE, "drugState", marker());
    norm.prepareData();
    await sleep(50);
    const nm = norm._mechDrugMods || {};
    out.normDrug = { refApplied: "ref" in nm, coolApplied: "cool" in nm };   // true,true

    for (const a of [borg, norm]) await a.delete().catch(() => {});
  } catch (e) {
    out.THROWN = String(e?.stack || e);
  }
  return out;
});

const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
const ok = (name, cond, got) => checks.push({ name, ok: !!cond, got });
if (r.THROWN) checks.push({ name: "no throw", ok: false, got: r.THROWN });

// (1) multi-action
eq("ACPA penalty −3,−4,−5,−6 (MM p.54)", r.penaltyAcpa, [0, -3, -4, -5, -6]);
eq("non-ACPA penalty −3/action (CP2020)", r.penaltyGrunt, [0, -3, -6, -9, -12]);
eq("_isAcpa", r.isAcpa, [true, false]);
eq("½-REF action cap (min 1)", r.maxActions, [5, 4, 3, 1, 1, 1]);

// (2) FBC drug
ok("FBC_SET_STATS = {ref,ma,bt}", r.setStats, r.setStats);
eq("drugAffectsSetStat", [r.affectsSet?.ref, r.affectsSet?.body, r.affectsSet?.cool, r.affectsSet?.mixed], [true, true, false, true]);
ok("full borg detected", r.borgDrug?.isFullBorg, r.borgDrug);
ok("borg REF drug boost DROPPED", r.borgDrug?.refDropped, r.borgDrug);
ok("borg COOL drug boost applies", r.borgDrug?.coolApplied, r.borgDrug);
ok("normal char keeps REF+COOL boosts", r.normDrug?.refApplied && r.normDrug?.coolApplied, r.normDrug);

ok("0 console errors", errors.length === 0, errors.slice(0, 6));

const pass = checks.filter(c => c.ok).length, fail = checks.length - pass;
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "  got=" + JSON.stringify(c.got) + (c.want !== undefined ? " want=" + JSON.stringify(c.want) : "")}`);
console.log(`\nRESULT: ${fail === 0 ? "ALL GREEN" : "FAIL"}  ${pass}/${checks.length}`);
if (errors.length) console.log("ERRORS:\n" + errors.slice(0, 8).join("\n"));
await b.close();
process.exit(fail === 0 ? 0 : 1);
