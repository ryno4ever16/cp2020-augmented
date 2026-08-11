/** LIVE verification on :30004 (vanilla Tilt 1.1.1 + module) of the pre-D4 cleanup batch:
 *  1 delete-dialog guard · 2 group-remove ⊗ · 3 FBC shop category · 4 single-FBC reject ·
 *  5 per-zone option-slot badge + enforce · 6 SDP row stays inside its card · 7 stat display floor
 *  (EMP 0, others 1). Uses the real Dragoon body from the re-seeded pack. Each item is guarded so a
 *  single failure still reports the rest. Assertion text names the mechanism, not the fiction. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = { err: {} };
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const guard = async (name, fn) => { try { await fn(); } catch (e) { out.err[name] = String(e?.stack || e?.message || e); } };
  const packBy = (name) => game.packs.get(`cp2020-augmented.${name}`) || [...game.packs].find(pk => pk.metadata?.name === name);
  const cyber = packBy("supplement-cyberware");
  const chips = packBy("supplement-chipware");
  out.packs = { cyber: !!cyber, chips: !!chips };
  if (!cyber || !chips) return out;

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Cleanup"))) await a.delete().catch(() => {});

  // ── item 3 (pure): FBC category classification + the index flag projection ──────────────────────
  await guard("item3", async () => {
    const cats = await import("/modules/cp2020-augmented/module/shop/categories.js");
    out.item3_classify = cats.categoryOfItem("cyberware", {}, { "cp2020-augmented": { borgBody: { sdp: { Head: 50 } } } });
    out.item3_inList = cats.CATEGORIES.some(c => c.key === "FBC");
    out.item3_normalStillCyber = cats.categoryOfItem("cyberware", { cyberwareType: "" }, {}); // no borgBody → Cyberware
    const fidx = await cyber.getIndex({ fields: ["flags.cp2020-augmented.borgBody", "type"] });
    const de = fidx.find(e => e.name === "Dragoon");
    out.item3_indexHasFlag = !!(de?.flags?.["cp2020-augmented"]?.borgBody);
  });

  // ── scratch borg with the real Dragoon (drives items 2/4/5/6/7) ─────────────────────────────────
  const cidx = await cyber.getIndex();
  const dragoon = await cyber.getDocument(cidx.find(e => e.name === "Dragoon")._id);
  const actor = await Actor.create({ name: "__PW__CleanupBorg", type: "character" });
  const [body] = await actor.createEmbeddedDocuments("Item", [dragoon.toObject()]);
  await body.update({ "system.equipped": true });
  const opts = () => actor.items.filter(i => i.getFlag("cp2020-augmented", "loadoutSource") === body.id);
  // Assert the MANIFEST's own spec count, not a floor — a spec silently dropped by materialization must
  // fail this, not slide under a stale >=20. Multi-pass materialization: wait for the count to STABILIZE.
  const manifestLen = (body.getFlag("cp2020-augmented", "loadout") ?? []).length;
  { let last = -1, stable = 0; for (let i = 0; i < 80 && stable < 3; i++) { await sleep(200); const n = opts().length; if (n > 0 && n === last) stable++; else { stable = 0; last = n; } } }
  out.materializedCount = opts().length;
  out.manifestLen = manifestLen;

  // ── item 4: equipping a SECOND borg body is rejected (stays unequipped) ──────────────────────────
  await guard("item4", async () => {
    const [body2] = await actor.createEmbeddedDocuments("Item", [dragoon.toObject()]);
    await body2.update({ "system.equipped": true }).catch(() => {});
    await sleep(300);
    out.item4_secondEquipped = body2.system?.equipped;      // expect false (vetoed)
    await body2.delete().catch(() => {});
  });

  // ── item 7a: EMP display floors at 0 while the true value is negative ────────────────────────────
  await guard("item7-emp", async () => {
    const [hc] = await actor.createEmbeddedDocuments("Item", [{ name: "__pw_hc", type: "cyberware", system: { equipped: true, humanityLoss: 300 } }]);
    await sleep(200);
    await actor.sheet.render(true); await sleep(1100);
    const root = actor.sheet.element;
    out.item7_empTrue = Number(actor.system?.stats?.emp?.total);       // negative
    out.item7_empShown = root?.querySelector('.stat-total[data-stat-name="emp"]')?.value;  // "0"
    await hc.delete().catch(() => {});
  });

  // ── item 5: per-zone option-slot badges on the anatomy headers (Dragoon rArm/lArm = 4) ───────────
  await guard("item5", async () => {
    await actor.sheet.render(true); await sleep(900);
    const root = actor.sheet.element;
    const badges = [...(root?.querySelectorAll(".active-cyberware-segment .cp-capacity-badge") || [])].map(b => b.textContent.trim());
    out.item5_badges = badges;                                  // e.g. ["1/5","4/5",...]
    // pools are TOTAL capacity now (factory + book-free): Dragoon arm = 4 free + 1 factory mount = 5
    out.item5_hasArmTotal5 = badges.some(t => /\/\s*5$/.test(t));
  });

  // ── item 2: the ⊗ group-remove control is present on the body's anchor row ──────────────────────
  await guard("item2", async () => {
    const root = actor.sheet.element;
    out.item2_groupRemovePresent = !!root?.querySelector(".cp-group-remove");
  });

  // ── item 6: the SDP number-pair row stays within its hit-location card (no bottom overflow) ──────
  await guard("item6", async () => {
    const root = actor.sheet.element;
    const ad = root?.querySelector(".armor-display");
    const tabSection = ad?.closest(".tab[data-tab]");
    const tabName = tabSection?.dataset?.tab;
    if (tabName) { [...root.querySelectorAll(`[data-tab="${tabName}"]`)].forEach(el => { if (el !== tabSection && (el.tagName === "A" || el.classList.contains("item"))) el.click?.(); }); }
    await sleep(500);
    const rows = [...(root?.querySelectorAll(".armor-display .segment-sdp-row") || [])];
    let checked = 0, overflow = 0;
    for (const row of rows) {
      const card = row.closest(".armor-segment"); if (!card) continue;
      const rr = row.getBoundingClientRect(), cr = card.getBoundingClientRect();
      if (rr.height === 0) continue; checked++;
      if (rr.bottom > cr.bottom + 1) overflow++;
    }
    out.item6_sdp = { checked, overflow };
  });
  await actor.sheet.close().catch(() => {});

  // ── item 5 (enforce): an oversized option is blocked from a full borg zone; a fitting one installs ─
  await guard("item5-enforce", async () => {
    const mk = (slots, tag) => ({ name: `__pw_arm_${tag}`, type: "cyberware", system: { equipped: false, MountZone: "Arm", CyberBodyType: { Type: "Arm" }, Module: { SlotsTaken: slots } } });
    const [big] = await actor.createEmbeddedDocuments("Item", [mk(10, "big")]);
    const [small] = await actor.createEmbeddedDocuments("Item", [mk(1, "small")]);
    await actor.sheet.render(true); await sleep(700);
    const root = actor.sheet.element;
    const zoneEl = root.querySelector('[data-drop-target="zone:r-arm"]');
    out.item5_zoneElFound = !!zoneEl;
    const drop = async (it) => { await actor.sheet._onDropItem({ preventDefault() {}, target: zoneEl }, { type: "Item", uuid: it.uuid }); await sleep(300); };
    await drop(big);
    out.item5_bigBlocked = big.system?.equipped === false;     // r-arm roots + 10 > 5 total → blocked
    await drop(small);
    out.item5_smallInstalled = small.system?.equipped === true; // roots + 1 ≤ 5 total → allowed
    await actor.sheet.close().catch(() => {});
    await big.delete().catch(() => {}); await small.delete().catch(() => {});
  });

  // ── item 7b: a non-EMP stat display floors at 1 when driven negative ─────────────────────────────
  await guard("item7-floor1", async () => {
    const n = await Actor.create({ name: "__PW__CleanupNormal", type: "character" });
    await n.update({ "system.stats.ref.tempMod": -40 });
    await sleep(150); await n.sheet.render(true); await sleep(800);
    out.item7_refTrue = Number(n.system?.stats?.ref?.total);   // negative
    out.item7_refShown = n.sheet.element?.querySelector('.stat-total[data-stat-name="ref"]')?.value;  // "1"
    await n.sheet.close().catch(() => {});
    await n.delete().catch(() => {});
  });

  // ── item 1: deleting a chip resolves cleanly (guard makes the confirm dialog always dismiss) ─────
  await guard("item1", async () => {
    const dt = await chips.getDocument((await chips.getIndex()).find(e => e.name === "Death Trance")._id);
    const [chip] = await actor.createEmbeddedDocuments("Item", [dt.toObject()]);
    const cid = chip.id;
    let delErr = null;
    try { await chip.delete(); } catch (e) { delErr = String(e?.message || e); }
    out.item1_delete = { error: delErr, gone: !actor.items.get(cid) };
  });

  // ── item 2 (redesign): clearing a body's loadout UNEQUIPS its options (kept → carried), not delete ─
  await guard("item2-deactivate", async () => {
    const L = await import("/modules/cp2020-augmented/module/mech/loadout.js");
    const bodyOpts = () => actor.items.filter(i => i.getFlag("cp2020-augmented", "loadoutSource") === body.id);
    const before = bodyOpts().length;
    await L.deactivateLoadout(actor, body.id);
    await sleep(400);
    const after = bodyOpts();
    out.item2_optsKept = before > 0 && after.length === before;               // none deleted
    out.item2_optsUnequipped = after.length > 0 && after.every(i => i.system?.equipped !== true); // all carried
    await actor.sheet.render(true); await sleep(900);
    out.item2_carriedShown = [...(actor.sheet.element?.querySelectorAll(".carried-options .cp-carried") || [])].length;
    await actor.sheet.close().catch(() => {});
  });

  await actor.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["compendium packs load", r.packs?.cyber === true && r.packs?.chips === true],
  ["item3: a borgBody item classifies to the FBC shop category", r.item3_classify?.category === "FBC"],
  ["item3: FBC is a top-level category; a normal cyberware still classifies to Cyberware", r.item3_inList === true && r.item3_normalStillCyber?.category === "Cyberware"],
  ["item3: the catalog index projects the borgBody flag (so classification runs)", r.item3_indexHasFlag === true],
  ["setup: the Dragoon loadout materialized (exactly the manifest spec count)", r.materializedCount === r.manifestLen && (r.manifestLen || 0) > 0],
  ["item4: a second equipped body is vetoed (stays unequipped)", r.item4_secondEquipped === false],
  ["item7: EMP true value is negative but the display reads 0", Number(r.item7_empTrue) < 0 && r.item7_empShown === "0"],
  ["item5: an anatomy zone header shows a used/total badge with total 5 (Dragoon arm, factory+free)", r.item5_hasArmTotal5 === true],
  ["item2: the ⊗ clear-options control renders on the body anchor row", r.item2_groupRemovePresent === true],
  ["item2: clearing a body's loadout UNEQUIPS its options (kept, not deleted)", r.item2_optsKept === true && r.item2_optsUnequipped === true],
  ["item2: the unequipped options appear in the Carried Options area", (r.item2_carriedShown || 0) > 0],
  ["item5: an oversized option is blocked from a full-capacity borg zone", r.item5_bigBlocked === true],
  ["item5: a fitting option still installs into that zone", r.item5_smallInstalled === true],
  ["item6: the SDP row renders inside its card (0 bottom overflow across the shown rows)", (r.item6_sdp?.checked || 0) > 0 && r.item6_sdp?.overflow === 0],
  ["item7: a non-EMP stat driven negative displays 1", Number(r.item7_refTrue) < 1 && r.item7_refShown === "1"],
  ["item1: deleting a chip resolves cleanly and the item is gone", r.item1_delete?.error === null && r.item1_delete?.gone === true],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (Object.keys(r.err || {}).length) console.log("lane errors:", r.err);
if (errors.length) console.log("console/page errors:", errors.slice(0, 8));
await b.close();
process.exit(fail ? 1 : 0);
