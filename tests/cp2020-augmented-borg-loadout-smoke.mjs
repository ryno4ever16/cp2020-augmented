/** LIVE SMOKE TEST on :30004 against the RE-SEEDED compiled compendium (not inline fixtures):
 *  import the real Dragoon body -> its loadout materializes, lands in zones, and SETs REF/MA/BODY;
 *  import a real re-typed chip -> it is typed Chip in the pack and sections when active. */
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
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const packBy = (name) => game.packs.get(`cp2020-augmented.${name}`) || [...game.packs].find(pk => pk.metadata?.name === name);
  const cyber = packBy("supplement-cyberware");
  const chips = packBy("supplement-chipware");
  out.packs = { cyber: !!cyber, chips: !!chips };
  if (!cyber || !chips) return out;

  // ── Pull the REAL Dragoon from the re-seeded pack ──────────────────────────
  const cidx = await cyber.getIndex();
  const dEntry = cidx.find(e => e.name === "Dragoon");
  const dragoon = await cyber.getDocument(dEntry._id);
  const dstats = dragoon.flags?.["cp2020-augmented"]?.borgBody?.stats;
  const dman = dragoon.flags?.["cp2020-augmented"]?.loadout;
  out.dragoonPack = { hasStats: !!dstats && dstats.ref === 15 && dstats.ma === 25 && dstats.body === 20, manifestLen: Array.isArray(dman) ? dman.length : 0 };

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Smoke"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__SmokeBorg", type: "character" });
  const [body] = await actor.createEmbeddedDocuments("Item", [dragoon.toObject()]);
  out.installedEquipped = body.system?.equipped === true;   // pack copy may already be equipped:false
  await body.update({ "system.equipped": true });           // trigger materialization
  // poll for the loadout to materialize
  const opts = () => actor.items.filter(i => i.getFlag("cp2020-augmented", "loadoutSource") === body.id);
  // The expected count is the MANIFEST's own length (assert values, not floors — a spec silently
  // dropped by materialization must fail this, not slide under a stale floor).
  const manifestLen = (body.getFlag("cp2020-augmented", "loadout") ?? []).length;
  for (let i = 0; i < 40 && opts().length < manifestLen; i++) await sleep(200);
  const zones = {}; for (const o of opts()) { const z = String(o.system?.MountZone || ""); zones[z] = (zones[z] || 0) + 1; }
  out.materialized = { count: opts().length, zones, manifestLen };
  // FBC stats seeded in prepareData
  for (let i = 0; i < 25 && (Number(actor.system?.stats?.ref?.total) || 0) !== 15; i++) await sleep(200);
  out.fbcStats = { ref: Number(actor.system?.stats?.ref?.total), ma: Number(actor.system?.stats?.ma?.total), bt: Number(actor.system?.stats?.bt?.total) };
  out.borgSdp = { head: Number(actor.system?.sdp?.sum?.Head), torso: Number(actor.system?.sdp?.sum?.Torso) };  // Dragoon 50 / 60

  // Sheet render: options show in their zone sections; the zoneless chassis has its own pinned strip.
  await actor.sheet.render(true); await sleep(1200);
  const root = actor.sheet.element;
  const zoneLabels = [...(root?.querySelectorAll(".active-cyberware-segment .field.gear label") || [])].map(l => l.textContent.trim());
  // Count the 3 distinct option KINDS present (not raw labels): the Quick-Change Weapon Mount fans out across
  // all four limbs on the current Dragoon manifest, so a raw-label count is 6 — assert each named kind renders.
  out.sheetShowsOptions = ["Front Optic Mount", "Quick-Change Weapon Mount", "Pain Editor"]
    .filter(pat => zoneLabels.some(t => t.toLowerCase().includes(pat.toLowerCase()))).length;
  // The flat cyberware tree was removed; the Dragoon body now folds into the Active Cyberware header
  // (name + ⊗ clear-loadout control), no dedicated segment.
  const chassis = root?.querySelector('.cp-active-cyber-header .cp-chassis-inline');
  out.treeHasBodyRoot = !!chassis?.textContent?.includes("Dragoon") && !!chassis?.querySelector('.cp-group-remove');
  await actor.sheet.close().catch(() => {});

  // ── Chip sectioning: a re-typed flavor chip is typed Chip in the pack + sections when active ──
  const chidx = await chips.getIndex();
  const dtEntry = chidx.find(e => e.name === "Death Trance");
  const dt = await chips.getDocument(dtEntry._id);
  out.chipPackTyped = dt.system?.CyberWorkType?.Type === "Chip";   // was Descriptive before the consolidation
  const [chip] = await actor.createEmbeddedDocuments("Item", [dt.toObject()]);
  await chip.update({ "system.equipped": true, "system.CyberWorkType.ChipActive": true }); await sleep(400);
  const cwt = chip.system?.CyberWorkType ?? {};
  const isChip = (Array.isArray(cwt.Types) ? cwt.Types.includes("Chip") : cwt.Type === "Chip") && cwt.ChipActive === true && chip.system?.equipped === true;
  out.chipSections = isChip;
  await actor.sheet.render(true); await sleep(1000);
  out.chipInActiveArea = !!actor.sheet.element?.querySelector(".chipware-container")?.textContent?.includes("Death Trance");
  await actor.sheet.close().catch(() => {});

  await actor.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["compendium packs load", r.packs?.cyber === true && r.packs?.chips === true],
  ["Dragoon in the pack carries FBC stats (15/25/20) + a 38-spec manifest (mounts, booms + split sensory items)", r.dragoonPack?.hasStats === true && r.dragoonPack?.manifestLen === 38],
  ["installing the Dragoon materializes its loadout (exactly the manifest's spec count)", r.materialized?.count === r.materialized?.manifestLen && (r.materialized?.manifestLen ?? 0) > 0],
  ["options land across the expected zones (Head/Arm/Leg/Nervous/Torso)", r.materialized && ["Head","Arm","Leg","Nervous","Torso"].every(z => (r.materialized.zones[z] || 0) > 0)],
  ["FBC chassis SETs REF/MA/BODY (15/25/20)", r.fbcStats?.ref === 15 && r.fbcStats?.ma === 25 && r.fbcStats?.bt === 20],
  ["borg per-zone SDP seeded (Dragoon Head 50 / Torso 60)", r.borgSdp?.head === 50 && r.borgSdp?.torso === 60],
  ["sheet shows materialized options in their zone sections (all 3 named labels)", r.sheetShowsOptions === 3],
  ["the zoneless chassis renders in the chassis strip with its ⊗ clear control", r.treeHasBodyRoot === true],
  ["a re-typed chip is typed Chip in the re-seeded pack", r.chipPackTyped === true],
  ["that chip, equipped+active, qualifies as a sectioned chip", r.chipSections === true],
  ["the active chip renders in the active-chip area", r.chipInActiveArea === true],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
