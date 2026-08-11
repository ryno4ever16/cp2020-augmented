/** Apply-damage dialog: SDP-honest preview (module unit "SDP-honest damage dialog").
 *
 *  The dialog PREVIEW used to run every row through the flesh net-damage math (BTM subtraction, min-1
 *  floor, head/limb doubling), even rows that route to a machine zone's SDP — where Apply actually
 *  writes the rounded after-armor value with NO BTM and NO doubling. This keeper proves the preview now
 *  SPLITS the summary: a flesh "Total HP" line (BTM math over flesh rows only) + a "Structural (SDP)"
 *  line (penetrating after-armor value over machine rows, un-BTM'd), each row tagged, and the two lines
 *  matching what Apply writes. Runs on :30004 (official 1.1.1 + module — ship target); also v13 :30003.
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
  const out = {};
  // A rig freshly (re)launched can have no active scene → canvas noise trips the 0-console-errors
  // assertion (harness rule). The dialog itself needs no canvas, but activate one defensively.
  if (!game.scenes?.active && game.scenes?.size) {
    await (game.scenes.getName("Foundry Virtual Tabletop") ?? game.scenes.contents[0])?.activate?.().catch(() => {});
  }
  const DD = await import("/modules/cp2020-augmented/module/combat/DamageDialog.js");
  const DA = await import("/modules/cp2020-augmented/module/combat/DamageApplicator.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const num = (t) => (t == null ? null : Number(String(t).trim()));
  const closeDlgs = () => Object.values(ui.windows).filter(w => w.constructor?.name === "DamageDialog").forEach(w => w.close());

  // ── fixture 1: a character with a Right cyberarm (rArm routes to SDP; Torso stays flesh) ──────────
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__DlgSdp"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__DlgSdpPunk", type: "character" });
  await actor.update({ "system.damage": 0, "system.stats.bt.value": 5 });
  await actor.createEmbeddedDocuments("Item", [{ name: "__PW__RArm", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent", cyberwareType: "CyberArm", MountZone: "Arm",
      CyberBodyType: { Type: "", Location: "Right" },
      CyberWorkType: { Type: "Implant", Types: ["Implant"], SDP: 30 } } }]);
  for (let i = 0; i < 25 && (Number(actor.system?.sdp?.sum?.rArm) || 0) !== 30; i++) await sleep(200);
  const btm = Number(actor.system.stats?.bt?.modifier) || 0;
  out.btm = btm;
  out.sumRArm = Number(actor.system?.sdp?.sum?.rArm) || 0;   // 30
  // Expected values (armor ignored ⇒ after-armor == raw). Mirror the seam exactly, no re-use of prod code:
  //   flesh Torso 10 → net = max(1, 10 − BTM)   |   SDP rArm 15 → structural = round(15) = 15 (no BTM)
  const RAW_FLESH = 10, RAW_SDP = 15;
  out.expFlesh = Math.max(1, RAW_FLESH - btm);
  out.expSdp   = RAW_SDP;

  // ── (A) preview: rows tagged, totals split ───────────────────────────────────────────────────────
  closeDlgs();
  const payloadA = { weaponName: "__PW__MixedVolley", areaDamages: { Torso: [{ damage: RAW_FLESH }], rArm: [{ damage: RAW_SDP }] }, ap: false };
  const dlgA = new DD.DamageDialog(payloadA, actor);
  dlgA._armorMode = "none"; dlgA._ablate = false;   // isolate the split from armor/ablation
  await dlgA.render(true); await sleep(800);
  const rootA = dlgA.element;
  const rows = [...rootA.querySelectorAll(".damage-hit")].map(row => ({
    loc: row.querySelector("span")?.textContent?.trim(),
    hasTag: !!row.querySelector(".damage-sdp-tag"),
    tagText: row.querySelector(".damage-sdp-tag")?.textContent?.trim() ?? "",
  }));
  out.rows = rows;
  const torsoRow = rows.find(x => x.loc === "Torso") ?? {};
  const rArmRow  = rows.find(x => x.loc === "rArm") ?? {};
  out.tagFlesh = { loc: "Torso", hasTag: torsoRow.hasTag };
  out.tagSdp   = { loc: "rArm",  hasTag: rArmRow.hasTag, tagText: rArmRow.tagText };
  const fleshEl = () => num(rootA.querySelector(".damage-total-value")?.textContent);
  const sdpEl   = () => { const el = rootA.querySelector(".damage-sdp-total-value"); return el ? num(el.textContent) : null; };
  out.totalsInitial = { flesh: fleshEl(), sdp: sdpEl() };
  // The SDP tag tooltip carries the live pool (30 / 30) and no BTM/wound-track claim.
  const tagTip = rArmRow.hasTag ? rootA.querySelector(".damage-sdp-tag")?.getAttribute("title") ?? "" : "";
  out.tagTip = { hasPool: /30\s*\/\s*30/.test(tagTip), noRawKey: !/CYBERPUNK\./.test(tagTip) };
  // The after-armor input on the flesh row CLAIMS BTM will be subtracted ("BTM (−N) is subtracted");
  // the SDP row's tooltip must NOT make that claim (it may state the opposite — "No BTM is subtracted").
  const inpTitle = (idx) => rootA.querySelector(`input.after-sp-override[data-hit-index="${idx}"]`)?.getAttribute("title") ?? "";
  const claimsBtm = (t) => /BTM\s*\(/.test(t);   // the "BTM (−{btm})" promise form, not the word alone
  out.tipSdpNoBtm  = claimsBtm(inpTitle(1)) === false && inpTitle(1) !== inpTitle(0);   // rArm row (index 1)
  out.tipFleshBtm  = claimsBtm(inpTitle(0)) === true;                                    // Torso row (index 0)

  // ── (D) override edits drive both totals (real change event) ──────────────────────────────────────
  const setOverride = (idx, val) => {
    const inp = rootA.querySelector(`input.after-sp-override[data-hit-index="${idx}"]`);
    inp.value = String(val);
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  };
  setOverride(1, 22); await sleep(150);                 // rArm SDP override → structural total = round(22)
  out.afterSdpOverride = { flesh: fleshEl(), sdp: sdpEl() };
  setOverride(0, 20); await sleep(150);                 // Torso flesh override → flesh total = max(1,20−BTM)
  out.afterFleshOverride = { flesh: fleshEl(), sdp: sdpEl() };
  out.expFleshOverride = Math.max(1, 20 - btm);
  await dlgA.close().catch(() => {}); await sleep(200);

  // ── (E) Apply matches the preview (fresh dialog, no overrides) ─────────────────────────────────────
  closeDlgs();
  const damageBefore = Number(actor.system?.damage) || 0;              // 0
  const rArmBefore   = Number(actor.system?.sdp?.current?.rArm);       // 30
  const dlgB = new DD.DamageDialog(payloadA, actor);
  dlgB._armorMode = "none"; dlgB._ablate = false;
  await dlgB.render(true); await sleep(800);
  const rootB = dlgB.element;
  out.applyPreview = {
    flesh: num(rootB.querySelector(".damage-total-value")?.textContent),
    sdp: (() => { const el = rootB.querySelector(".damage-sdp-total-value"); return el ? num(el.textContent) : null; })(),
  };
  rootB.querySelector('[data-action="applyDamage"]').click();
  for (let i = 0; i < 30 && ui.windows && Object.values(ui.windows).some(w => w === dlgB); i++) await sleep(150);
  await sleep(400);
  const damageAfter = Number(actor.system?.damage) || 0;
  const rArmAfter   = Number(actor.system?.sdp?.current?.rArm);
  out.applyResult = {
    fleshDelta: damageAfter - damageBefore,
    sdpDelta:   rArmBefore - rArmAfter,
    damageAfter, rArmAfter,
  };

  // ── (C) full-borg head hit: SDP total is NOT doubled even with head-doubling ON ────────────────────
  let priorHead = false;
  try { priorHead = game.settings.get("cp2020-augmented", "headHitDoubling"); } catch (e) {}
  try { await game.settings.set("cp2020-augmented", "headHitDoubling", true); } catch (e) {}
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__DlgBorg"))) await a.delete().catch(() => {});
  const borg = await Actor.create({ name: "__PW__DlgBorgPunk", type: "character" });
  await borg.update({ "system.damage": 0, "system.stats.bt.value": 5 });
  await borg.createEmbeddedDocuments("Item", [{ name: "__PW__BorgBody", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent" },
    flags: { "cp2020-augmented": { borgBody: {
      sp:  { Head:0, Torso:0, lArm:0, rArm:0, lLeg:0, rLeg:0 },   // 0 SP ⇒ isolate the SDP-total math from armor
      sdp: { Head:30, Torso:40, lArm:30, rArm:30, lLeg:30, rLeg:30 } } } } }]);
  for (let i = 0; i < 25 && (Number(borg.system?.sdp?.sum?.Head) || 0) !== 30; i++) await sleep(200);
  const borgBtm = Number(borg.system.stats?.bt?.modifier) || 0;
  closeDlgs();
  const payloadC = { weaponName: "__PW__BorgHead", areaDamages: { Head: [{ damage: 15 }] }, ap: false };
  const dlgC = new DD.DamageDialog(payloadC, borg);
  dlgC._armorMode = "none"; dlgC._ablate = false;
  await dlgC.render(true); await sleep(800);
  const rootC = dlgC.element;
  const borgRow = [...rootC.querySelectorAll(".damage-hit")].find(row => row.querySelector("span")?.textContent?.trim() === "Head");
  out.borg = {
    hasTag: !!borgRow?.querySelector(".damage-sdp-tag"),
    flesh: num(rootC.querySelector(".damage-total-value")?.textContent),
    sdp: (() => { const el = rootC.querySelector(".damage-sdp-total-value"); return el ? num(el.textContent) : null; })(),
    doubledFleshValue: 2 * Math.max(1, 15 - borgBtm),   // what a WRONG flesh+doubling preview would show
    headDoublingOn: (() => { try { return game.settings.get("cp2020-augmented", "headHitDoubling") === true; } catch { return false; } })(),
  };
  await dlgC.close().catch(() => {});
  try { await game.settings.set("cp2020-augmented", "headHitDoubling", priorHead); } catch (e) {}

  // ── (F) PURE-FLESH no-drift: a cyberware-free character, a 2-hit flesh volley ──────────────────────
  // The regression this unit could introduce: a pure-flesh volley must be UNCHANGED — no SDP tag, no
  // SDP total element (hasSdpRows false path), and the single Total-HP line must still equal the flat
  // sum of computeNetDamage over ALL rows. Two Torso hits (flesh, no limb/head doubling to muddy it).
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__DlgFlesh"))) await a.delete().catch(() => {});
  const flesh = await Actor.create({ name: "__PW__DlgFleshPunk", type: "character" });
  await flesh.update({ "system.damage": 0, "system.stats.bt.value": 5 });
  const fbtm = Number(flesh.system.stats?.bt?.modifier) || 0;
  closeDlgs();
  const RAW_A = 10, RAW_B = 6;
  const payloadF = { weaponName: "__PW__FleshVolley", areaDamages: { Torso: [{ damage: RAW_A }, { damage: RAW_B }] }, ap: false };
  const dlgF = new DD.DamageDialog(payloadF, flesh);
  dlgF._armorMode = "none"; dlgF._ablate = false;
  await dlgF.render(true); await sleep(800);
  const rootF = dlgF.element;
  // Expectation computed FROM THE INPUTS via the real net-damage math (armor ignored ⇒ afterSP == raw).
  const expFleshOnly = DA.computeNetDamage(RAW_A, fbtm, true, "Torso") + DA.computeNetDamage(RAW_B, fbtm, true, "Torso");
  const fRows = [...rootF.querySelectorAll(".damage-hit")];
  out.fleshOnly = {
    rowCount: fRows.length,
    anyTag: fRows.some(row => !!row.querySelector(".damage-sdp-tag")),
    sdpTotalEl: !!rootF.querySelector(".damage-sdp-total-value"),   // must be ABSENT (hasSdpRows false)
    total: num(rootF.querySelector(".damage-total-value")?.textContent),
    expTotal: expFleshOnly,
  };
  // (F-d) an override on the flesh volley still updates the single total. Set index 0 → 20.
  const fInp = rootF.querySelector('input.after-sp-override[data-hit-index="0"]');
  fInp.value = "20"; fInp.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(150);
  out.fleshOnly.afterOverride = num(rootF.querySelector(".damage-total-value")?.textContent);
  out.fleshOnly.expAfterOverride = DA.computeNetDamage(20, fbtm, true, "Torso") + DA.computeNetDamage(RAW_B, fbtm, true, "Torso");
  await dlgF.close().catch(() => {});

  // ── cleanup ────────────────────────────────────────────────────────────────────────────────────
  closeDlgs();
  await actor.delete().catch(() => {});
  await borg.delete().catch(() => {});
  await flesh.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["fixture: right cyberarm sums 30 SDP into rArm", r.sumRArm === 30],
  ["(a) SDP row (rArm) is tagged 'SDP'; flesh row (Torso) is NOT", r.tagSdp.hasTag === true && /SDP/i.test(r.tagSdp.tagText) && r.tagFlesh.hasTag === false],
  ["(a) SDP tag tooltip shows the live pool (30 / 30) and no raw i18n key", r.tagTip.hasPool === true && r.tagTip.noRawKey === true],
  ["(a) SDP-row after-armor tooltip does NOT claim BTM; flesh-row tooltip does", r.tipSdpNoBtm === true && r.tipFleshBtm === true],
  ["(b) flesh total = BTM math on the Torso row only (max(1,10−BTM))", r.totalsInitial.flesh === r.expFlesh],
  ["(b) structural total = penetrating after-armor on rArm, un-BTM'd (15)", r.totalsInitial.sdp === r.expSdp],
  ["(b) the two totals are SEPARATE numbers (flesh excludes the SDP row)", r.totalsInitial.flesh !== (r.expFlesh + r.expSdp)],
  ["(d) SDP after-armor override → structural total = round(22); flesh unchanged", r.afterSdpOverride.sdp === 22 && r.afterSdpOverride.flesh === r.expFlesh],
  ["(d) flesh after-armor override → flesh total = max(1,20−BTM); SDP stays 22", r.afterFleshOverride.flesh === r.expFleshOverride && r.afterFleshOverride.sdp === 22],
  ["(e) preview totals equal the pre-apply expectation", r.applyPreview.flesh === r.expFlesh && r.applyPreview.sdp === r.expSdp],
  ["(e) Apply writes flesh HP == flesh total", r.applyResult.fleshDelta === r.applyPreview.flesh],
  ["(e) Apply reduces the limb pool by == structural total", r.applyResult.sdpDelta === r.applyPreview.sdp],
  ["(c) borg-head fixture head-doubling is ON for the contrast", r.borg.headDoublingOn === true],
  ["(c) full-borg head row is tagged SDP", r.borg.hasTag === true],
  ["(c) borg head structural total = 15 (NOT doubled, NOT BTM'd)", r.borg.sdp === 15 && r.borg.sdp !== r.borg.doubledFleshValue],
  ["(c) borg head volley has NO flesh HP total", r.borg.flesh === 0],
  ["(F) pure-flesh volley: two rows, NO SDP tag on any row", r.fleshOnly.rowCount === 2 && r.fleshOnly.anyTag === false],
  ["(F) pure-flesh volley: NO structural (SDP) total element renders", r.fleshOnly.sdpTotalEl === false],
  ["(F) pure-flesh Total-HP == flat computeNetDamage sum over ALL rows", r.fleshOnly.total === r.fleshOnly.expTotal],
  ["(F) pure-flesh override still updates the single Total-HP correctly", r.fleshOnly.afterOverride === r.fleshOnly.expAfterOverride],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 8));
await b.close();
process.exit(fail ? 1 : 0);
