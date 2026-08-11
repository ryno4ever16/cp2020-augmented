/** Migration safety (run-3 finding L14): the vehicle actor's sp/sdp were converted from bare ObjectFields
 *  (whose migrateData mergeDefaults expanded a partial dotted update into a full object of defaults, wiping
 *  siblings) to nested SchemaFields. Asserts: (1) a partial system.sp.front / system.sdp.value update does
 *  NOT wipe the other keys; (2) a legacy source missing keys floats on defaults; (3) the SOP→SDP rename
 *  migrateData still carries a stored value forward. Runs on :30004. */
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
  const VEH = "cp2020-augmented.vehicle";
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__VMig"))) await a.delete().catch(() => {});
  try {
    // (1) partial sp/sdp update does NOT wipe siblings
    const v = await Actor.create({ name: "__PW__VMig", type: VEH, system: {
      sp: { front: 20, side: 15, rear: 10, top: 5, bottom: 8 }, sdp: { value: 100, max: 100 } } });
    await v.update({ "system.sp.front": 8 });
    await v.update({ "system.sdp.value": 40 });
    out.partial = {
      front: v.system.sp.front, side: v.system.sp.side, rear: v.system.sp.rear, top: v.system.sp.top, bottom: v.system.sp.bottom,
      sdpValue: v.system.sdp.value, sdpMax: v.system.sdp.max,
    };  // expect front 8, side 15, rear 10, top 5, bottom 8 (NOT wiped); sdpValue 40, sdpMax 100

    // (2) legacy source missing keys floats on defaults (no throw, siblings default to 0)
    const leg = await Actor.create({ name: "__PW__VMigLegacy", type: VEH, system: { sp: { front: 12 } } });
    out.legacy = { front: leg.system.sp.front, side: leg.system.sp.side, sdpValue: leg.system.sdp.value };  // 12, 0, 0

    // (3) the SOP→SDP rename migrateData still carries a stored value forward
    // frameSDP is a STORED field, so the rename value survives; interfaceSdp is DERIVED (recomputed each
    // prepare), so its rename is moot — assert only the stored one.
    const ren = await Actor.create({ name: "__PW__VMigRename", type: VEH, system: { isACPA: true,
      frameSOP: { head: 7, rArm: 3, lArm: 3, rLeg: 4, lLeg: 4, torso: 9 } } });
    out.rename = { frameSDPHead: ren.system.frameSDP?.head };  // 7

    for (const a of [v, leg, ren]) await a.delete().catch(() => {});
  } catch (e) { out.THROWN = String(e?.stack || e); }
  return out;
});

const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
if (r.THROWN) checks.push({ name: "no throw", ok: false, got: r.THROWN });
eq("partial sp.front update keeps other facings", [r.partial?.front, r.partial?.side, r.partial?.rear, r.partial?.top, r.partial?.bottom], [8, 15, 10, 5, 8]);
eq("partial sdp.value update keeps sdp.max", [r.partial?.sdpValue, r.partial?.sdpMax], [40, 100]);
eq("legacy partial sp floats on defaults", [r.legacy?.front, r.legacy?.side, r.legacy?.sdpValue], [12, 0, 0]);
eq("frameSOP→frameSDP rename carries value forward", r.rename?.frameSDPHead, 7);
checks.push({ name: "0 console errors", ok: errors.length === 0, got: errors.slice(0, 6) });

const pass = checks.filter(c => c.ok).length, fail = checks.length - pass;
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "  got=" + JSON.stringify(c.got) + (c.want !== undefined ? " want=" + JSON.stringify(c.want) : "")}`);
console.log(`\nRESULT: ${fail === 0 ? "ALL GREEN" : "FAIL"}  ${pass}/${checks.length}`);
await b.close();
process.exit(fail === 0 ? 0 : 1);
