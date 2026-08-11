/** Q9 chip wirings (SPECIAL-MECHANICS-PROPOSAL.md §3b): Facedown Chip +1 (rollFacedown card line),
 *  Photo Memory INT +2 (stat-roll Modifiers dialog), Ambidexterity +3 (fire-dialog row shown only
 *  while Dual Wield is checked, cancelling the −3). Pure providers + the three e2e paths. */
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
  const R = await import("/modules/cp2020-augmented/module/mech/roll-mods.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const lastNumericInCard = (m) => {
    const div = document.createElement("div"); div.innerHTML = m?.content ?? "";
    const nums = [...div.querySelectorAll(".roll-result.inactive")].map(s => s.textContent.trim()).filter(t => /^-?\d+$/.test(t));
    return nums.length ? Number(nums[nums.length - 1]) : null;
  };

  // ── (0) PURE ──────────────────────────────────────────────────────────────
  const chip = (rm) => ({ id: "c" + Math.floor(rm.facedownMod ?? rm.statMod ?? rm.attackMod ?? 0), type: "cyberware", name: "Chip",
    system: { equipped: true, EffectMode: "Permanent", CyberWorkType: { Types: ["Chip"], ChipActive: true },
      mechRollMods: { enabled: true, attackMod: 0, skillName: "", skillMod: 0, auto: true, statName: "", statMod: 0, facedownMod: 0, dualWieldOnly: false, ...rm } } });
  out.pure = {
    statMatch: R.statModProviders([chip({ statName: "int", statMod: 2 })], "int").length,
    statMiss: R.statModProviders([chip({ statName: "int", statMod: 2 })], "cool").length,
    facedown: R.facedownModFor([chip({ facedownMod: 1 })]),
    dualWieldFlag: R.attackModProviders([chip({ attackMod: 3, dualWieldOnly: true })])[0]?.dualWieldOnly,
    chipOffExcluded: R.facedownModFor([{ ...chip({ facedownMod: 1 }), system: { ...chip({ facedownMod: 1 }).system, CyberWorkType: { Types: ["Chip"], ChipActive: false } } }]).total
  };

  // ── (1) Facedown Chip +1 ──────────────────────────────────────────────────
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Q9"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__Q9Punk", type: "character" });
  await actor.update({ "system.stats.cool.base": 6 }); await sleep(200);
  // NOTE: the Facedown Chip is MODULE-OWNED pack data (src/packs/supplement-chipware/), so it lives in
  // `cp2020-augmented.supplement-chipware`. The old id here was `cyberpunk2020.chipware` — a SYSTEM-scope
  // pack that DOES NOT EXIST on the rig, so the optional chain short-circuited to undefined and the assert
  // failed. Rig-proven: the chip resolves in the module pack carrying facedownMod 1. Stale test reference,
  // not a product/data bug.
  const fdChip = await game.packs.get("cp2020-augmented.supplement-chipware")?.getDocument("rGiu9TBJAmowrXIm").catch(() => null);
  // Assert the fetched pack chip actually carries the wired facedown bonus (module pack data), not just fetch it.
  out.fdChipPack = { found: !!fdChip, facedownMod: fdChip ? Number(fdChip.system?.mechRollMods?.facedownMod) : null };
  const [fd] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__Facedown", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent", CyberWorkType: { Types: ["Chip"], ChipActive: true, Stat: {}, Skill: {}, ChipSkills: {} },
      mechRollMods: { enabled: true, facedownMod: 1, auto: true } } }]);
  await sleep(300);
  const rep = await import("/modules/cp2020-augmented/module/actor/reputation.js");
  let before = new Set(game.messages.contents.map(m => m.id));
  await rep.rollFacedown(actor); await sleep(1000);
  const fdMsg = game.messages.contents.filter(m => !before.has(m.id)).at(-1);
  const fdText = fdMsg?.content ?? "";
  // parse the line: die + COOL cool + Reputation rep + Chip chip = total
  const mLine = /🎲\s*(-?\d+).*?(\d+).*?(\d+).*?Chip\s*(\d+)\s*=\s*<b>(\d+)<\/b>/s.exec(fdText.replace(/<[^>]+>/g, m => m).replace(/\s+/g, " "));
  out.facedownE2E = {
    cardHasChip: /Chip\s*1/.test(fdText.replace(/<[^>]+>/g, " ")),
    // self-consistency: the rolled total should include the +1 (parse total vs die+cool+rep+chip)
    selfConsistent: !!mLine && (Number(mLine[5]) === Number(mLine[1]) + Number(mLine[2]) + Number(mLine[3]) + Number(mLine[4])),
    chipVal: mLine ? Number(mLine[4]) : null
  };
  await fd.delete().catch(() => {});

  // ── (2) Photo Memory INT +2 (stat-roll dialog) ─────────────────────────────
  await actor.update({ "system.stats.int.base": 7 }); await sleep(200);
  const [pm] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__PhotoMem", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent", CyberWorkType: { Types: ["Chip"], ChipActive: true, Stat: {}, Skill: {}, ChipSkills: {} },
      mechRollMods: { enabled: true, statName: "int", statMod: 2, auto: false } } }]);
  await sleep(300);
  const sheet = actor.sheet;
  // no provider on COOL → base rollStat, no dialog
  const dlgCountBefore = foundry.applications.instances.size;
  await sheet._cpRollStatFromElement({ dataset: { statName: "cool" } }); await sleep(600);
  out.statNoProvider = { noDialog: foundry.applications.instances.size <= dlgCountBefore };
  // INT has a provider → dialog opens with the row
  const sdlg = sheet._cpRollStatFromElement({ dataset: { statName: "int" } });
  let row = null;
  for (let i = 0; i < 40 && !row; i++) { await sleep(150); row = document.querySelector(`input[name="gearMod_${pm.id}"]`); }
  out.statProvider = { dialogRow: !!row, ticked: !!row?.checked };
  if (row) {
    row.checked = true;
    before = new Set(game.messages.contents.map(m => m.id));
    [...document.querySelectorAll('button[type="submit"], button.fire')].find(bt => bt.offsetParent !== null)?.click();
    await sleep(1200);
    const pmMsg = game.messages.contents.filter(m => !before.has(m.id)).at(-1);
    // the roll message carries a real Roll (toMessage) → total = int.total(9=7+2 via moddy? no moddy) + 2 = 7 + die + 2
    const rollTotal = (pmMsg?.rolls ?? [])[0]?.total ?? null;
    // int.total is 7; a plain d10 (>=1) + 7 + 2 → at least 10
    out.statRolled = { hasRoll: rollTotal !== null, includesPlus2: rollTotal !== null && rollTotal >= (7 + 2 + 1) };
  }
  await pm.delete().catch(() => {});
  await sheet.close().catch(() => {});

  // ── (3) Ambidexterity: fire-dialog row shown with Dual Wield, folds +3 ─────
  const [ambi] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__Ambi", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent", CyberWorkType: { Types: ["Chip"], ChipActive: true, Stat: {}, Skill: {}, ChipSkills: {} },
      mechRollMods: { enabled: true, attackMod: 3, dualWieldOnly: true, auto: true } } }]);
  const [gun] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__AmbiPistol", type: "weapon",
    system: { weaponType: "Pistol", attackType: "SemiAuto", range: 50, shots: 10, shotsLeft: 10, rof: 1, accuracy: 0, attackSkill: "" } }]);
  const fdlg = sheet._cpOpenWeaponAttackDialog(gun);
  await sleep(900);
  const ambiRowSel = `input[name="gearMod_${ambi.id}"]`;
  const ambiRow = fdlg.element?.querySelector(ambiRowSel);
  const ambiField = ambiRow?.closest(".field");
  const dwEl = fdlg.element?.querySelector('input[name="fields.dualWield"], input[name="dualWield"]');
  out.ambiVisibility = {
    rowPresent: !!ambiRow,
    hiddenInitially: !!ambiField?.classList.contains("cp-hidden"),
    dwPresent: !!dwEl
  };
  // tick Dual Wield → the row appears
  if (dwEl) { dwEl.checked = true; dwEl.dispatchEvent(new Event("change", { bubbles: true })); await sleep(300); }
  out.ambiVisibility.visibleAfterDW = !ambiField?.classList.contains("cp-hidden");
  // fire with dual wield on → extraMod folds the +3 (the last numeric card term); dualWield −3 is separate
  before = new Set(game.messages.contents.map(m => m.id));
  fdlg.element?.querySelector("button.fire")?.click();
  await sleep(1500);
  const ambiMsg = game.messages.contents.filter(m => !before.has(m.id)).at(-1);
  out.ambiFold = { lastTerm: ambiMsg ? lastNumericInCard(ambiMsg) : null };   // extraMod = +3

  // fire again with dual wield OFF → the ambi provider is excluded (extraMod 0)
  const fdlg2 = sheet._cpOpenWeaponAttackDialog(gun);
  await sleep(800);
  before = new Set(game.messages.contents.map(m => m.id));
  fdlg2.element?.querySelector("button.fire")?.click();
  await sleep(1500);
  const ambiMsg2 = game.messages.contents.filter(m => !before.has(m.id)).at(-1);
  out.ambiOffFold = { lastTerm: ambiMsg2 ? lastNumericInCard(ambiMsg2) : null };   // 0

  await actor.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["pure: statModProviders match / miss", r.pure.statMatch === 1 && r.pure.statMiss === 0],
  ["pure: facedownModFor sums active providers", r.pure.facedown.total === 1 && r.pure.facedown.sources.length === 1],
  ["pure: attackModProviders marks dualWieldOnly", r.pure.dualWieldFlag === true],
  ["pure: inactive chip contributes no facedown bonus", r.pure.chipOffExcluded === 0],
  ["facedown pack chip carries facedownMod 1 (corrections wired)", r.fdChipPack?.found === true && r.fdChipPack?.facedownMod === 1],
  ["facedown e2e: card shows the chip bonus", r.facedownE2E.cardHasChip === true],
  ["facedown e2e: rolled total includes the +1 (self-consistent)", r.facedownE2E.selfConsistent === true && r.facedownE2E.chipVal === 1],
  ["photo memory: a stat with no provider rolls directly (no dialog)", r.statNoProvider.noDialog === true],
  ["photo memory: INT provider opens the dialog with an unticked row", r.statProvider.dialogRow === true && r.statProvider.ticked === false],
  ["photo memory: confirmed stat roll includes the +2", r.statRolled?.hasRoll === true && r.statRolled?.includesPlus2 === true],
  ["ambidexterity: fire-dialog row hidden until Dual Wield is checked", r.ambiVisibility.rowPresent === true && r.ambiVisibility.hiddenInitially === true && r.ambiVisibility.visibleAfterDW === true],
  ["ambidexterity: firing dual-wielded folds the +3 (cancels the −3)", r.ambiFold.lastTerm === 3],
  ["ambidexterity: firing without dual wield excludes the +3", r.ambiOffFold.lastTerm === 0],
  ["0 console errors", errors.length === 0]
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
