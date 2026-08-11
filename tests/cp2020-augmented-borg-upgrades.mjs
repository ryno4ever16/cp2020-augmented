/**
 * Full-borg Increased options + the ACPA operating-REF cap override (:30004, unit ④).
 *
 * The purchased "Full Borg: Increased …" options now DO the printed thing (Chr2 p.84-85): each
 * equipped copy carries a one-step `borgStatDelta` flag summed by the borg engine onto the chassis
 * baseline — stats +1/copy clamped at REF 15 / MA 25 / BODY 20; SP +5/copy on every zone clamped
 * at 40; SDP +5/copy clamped at +20 over the chassis. And the ACPA derivation honors a GM
 * `refCapOverride` (the printed interlocked-cyborg exception — Shockwave's REF 15 + 2 = 17).
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-borg-upgrades.mjs
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
  try {
    for (const a of game.actors.filter(a => a.name.startsWith("__PW__BorgUpg"))) await a.delete().catch(() => {});

    // A baseline chassis (the Alpha shape: REF 10 / MA 10 / BODY 12; SP 25 all zones; SDP 20/30/40-ish).
    const bodyData = { name: "__PW__UpgBody", type: "cyberware", system: { equipped: true, EffectMode: "Permanent" },
      flags: { [SCOPE]: { borgBody: {
        stats: { ref: 10, ma: 10, body: 12 },
        sp: { Head: 25, Torso: 25, lArm: 25, rArm: 25, lLeg: 25, rLeg: 25 },
        sdp: { Head: 20, Torso: 40, lArm: 30, rArm: 30, lLeg: 30, rLeg: 30 },
      } } } };
    const step = (delta, n) => Array.from({ length: n }, (_, i) => ({
      name: `__PW__UpgStep_${Object.keys(delta)[0]}_${i}`, type: "cyberware",
      system: { equipped: true, EffectMode: "Permanent", MountZone: "Torso" },
      flags: { [SCOPE]: { borgStatDelta: delta } },
    }));

    const actor = await Actor.create({ name: "__PW__BorgUpg", type: "character" });
    await actor.createEmbeddedDocuments("Item", [bodyData]);
    await sleep(400);
    out.baseline = { ref: actor.system.stats.ref.total, ma: actor.system.stats.ma.total, bt: actor.system.stats.bt.total,
      spTorso: actor.system.hitLocations?.Torso?.stoppingPower, sdpTorso: actor.system.sdp?.sum?.Torso };

    // +2 REF steps → 12; the movement/body dependents follow their own stats.
    await actor.createEmbeddedDocuments("Item", step({ ref: 1 }, 2));
    await sleep(400);
    out.refPlus2 = actor.system.stats.ref.total;

    // Overshoot: 7 more REF steps (9 total) → clamped at the printed 15.
    await actor.createEmbeddedDocuments("Item", step({ ref: 1 }, 7));
    await sleep(400);
    out.refClamped = actor.system.stats.ref.total;

    // MA + BODY steps: +3 MA → 13 (run follows), +2 BODY → 14 (carry/BTM follow).
    await actor.createEmbeddedDocuments("Item", [...step({ ma: 1 }, 3), ...step({ body: 1 }, 2)]);
    await sleep(400);
    out.maPlus3 = { ma: actor.system.stats.ma.total, run: actor.system.stats.ma.run };
    out.bodyPlus2 = { bt: actor.system.stats.bt.total, carry: actor.system.stats.bt.carry };

    // SP: +4 steps (+20) on the SP-25 chassis → clamped at the printed 40 (not 45). The prepared
    // per-zone armor SP carries the fold (proportional combine of a single layer = the value).
    await actor.createEmbeddedDocuments("Item", step({ sp: 5 }, 4));
    await sleep(400);
    out.spClamped = actor.system.hitLocations?.Torso?.stoppingPower;

    // SDP: +5 steps (+25) → clamped at +20 over the chassis (Torso 40 → 60, not 65).
    await actor.createEmbeddedDocuments("Item", step({ sdp: 5 }, 5));
    await sleep(400);
    out.sdpClamped = { torso: actor.system.sdp?.sum?.Torso, arm: actor.system.sdp?.sum?.rArm };

    // Unequip drops the contribution (the toggle is honest).
    const refSteps = actor.items.filter(i => i.name.startsWith("__PW__UpgStep_ref"));
    await actor.updateEmbeddedDocuments("Item", refSteps.map(i => ({ _id: i.id, "system.equipped": false })));
    await sleep(400);
    out.refAfterUnequip = actor.system.stats.ref.total;
    await actor.delete().catch(() => {});

    // ── the ACPA operating-REF cap override ──
    const suit = await Actor.create({ name: "__PW__BorgUpgSuit", type: "cp2020-augmented.vehicle",
      system: { isACPA: true, reflexControl: "HIGH_BOOST", pilotRef: 15 } });
    await sleep(300);
    out.acpaRaw = { maxRef: suit.system.maxRef, effectiveRef: suit.system.effectiveRef };  // 12, 12 (15+2 clamped)
    await suit.update({ "system.refCapOverride": 17 });
    await sleep(300);
    out.acpaOverride = { maxRef: suit.system.maxRef, effectiveRef: suit.system.effectiveRef };  // 17, 17 (15+2)
    await suit.update({ "system.refCapOverride": 0 });
    await sleep(300);
    out.acpaRestored = suit.system.effectiveRef;  // back to 12
    await suit.delete().catch(() => {});
  } catch (e) { out.err = e?.message || String(e); }
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["chassis baseline SETs (10/10/12; SP 25; SDP Torso 40)", r.baseline && r.baseline.ref === 10 && r.baseline.ma === 10 && r.baseline.bt === 12 && r.baseline.spTorso === 25 && r.baseline.sdpTorso === 40],
  ["+2 REF steps raise the SET total to 12", r.refPlus2 === 12],
  ["9 REF steps clamp at the printed 15", r.refClamped === 15],
  ["+3 MA steps -> 13 with run re-derived (39)", r.maPlus3 && r.maPlus3.ma === 13 && r.maPlus3.run === 39],
  ["+2 BODY steps -> 14 with carry re-derived (140)", r.bodyPlus2 && r.bodyPlus2.bt === 14 && r.bodyPlus2.carry === 140],
  ["+20 SP on an SP-25 chassis clamps at the printed 40", r.spClamped === 40],
  ["+25 SDP clamps at +20 over the chassis (Torso 60, arm 50)", r.sdpClamped && r.sdpClamped.torso === 60 && r.sdpClamped.arm === 50],
  ["unequipping the REF steps returns the total to 10", r.refAfterUnequip === 10],
  ["ACPA RAW: High Boost caps the operating REF at 12", r.acpaRaw && r.acpaRaw.maxRef === 12 && r.acpaRaw.effectiveRef === 12],
  ["ACPA override 17: the interlocked exception reads 17 (15 + 2, uncapped)", r.acpaOverride && r.acpaOverride.maxRef === 17 && r.acpaOverride.effectiveRef === 17],
  ["clearing the override restores RAW (12)", r.acpaRestored === 12],
  ["no fixture/probe error", r.err === null],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
