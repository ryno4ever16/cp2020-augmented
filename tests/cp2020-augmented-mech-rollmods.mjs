/** P5 roll-modifier providers (SPECIAL-MECHANICS-PROPOSAL.md Phase D): the pure provider/group/sum
 *  helpers, the corrections-wired base items, and the two REAL dialog paths e2e — an equipped
 *  Smartgun Link adds a pre-ticked "+2" row to the fire dialog and lands in the attack roll; an
 *  imported Medscanner auto-opens the skill dialog (askMods false) and lands +2 in the skill roll;
 *  an unticked row contributes nothing. */
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
  const M = await import("/modules/cp2020-augmented/module/mech/roll-mods.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  // ── (0) PURE truth table over plain item shapes ────────────────────────────
  const mkMisc = (equipped, rm) => ({ id: "m1", type: "misc", name: "Widget",
    system: { equipped, mechRollMods: { enabled: true, attackMod: 0, skillName: "", skillMod: 0, auto: true, ...rm } } });
  const mkCyber = (over, rm) => ({ id: "c1", type: "cyberware", name: "Chrome",
    system: { equipped: true, EffectMode: "Permanent", EffectActive: false,
      CyberWorkType: { Types: [], ChipActive: false },
      mechRollMods: { enabled: true, attackMod: 0, skillName: "", skillMod: 0, auto: true, ...rm }, ...over } });

  out.pure = {
    disabledNull: M.rollModsOf({ system: { mechRollMods: { enabled: false, attackMod: 2 } } }) === null,
    attackBasic: M.attackModProviders([mkMisc(true, { attackMod: 2 })]),
    unequipped: M.attackModProviders([mkMisc(false, { attackMod: 2 })]).length,
    zeroMod: M.attackModProviders([mkMisc(true, { attackMod: 0 })]).length,
    activatableOff: M.attackModProviders([mkCyber({ EffectMode: "Activatable", EffectActive: false }, { attackMod: 2 })]).length,
    activatableOn: M.attackModProviders([mkCyber({ EffectMode: "Activatable", EffectActive: true }, { attackMod: 2 })]).length,
    chipInactive: M.attackModProviders([mkCyber({ CyberWorkType: { Types: ["Chip"], ChipActive: false } }, { attackMod: 1 })]).length,
    chipActive: M.attackModProviders([mkCyber({ CyberWorkType: { Types: ["Chip"], ChipActive: true } }, { attackMod: 1 })]).length,
    skillMatch: M.skillModProviders([mkMisc(true, { skillName: "Diagnose Illness", skillMod: 2 })], "diagnose illness").length,
    skillMiss: M.skillModProviders([mkMisc(true, { skillName: "Diagnose Illness", skillMod: 2 })], "First Aid").length,
    // multi-skill list (the ParaDactyl/Micromanipulator widening): one row per matching entry
    listMatch: M.skillModProviders([mkMisc(true, { skillMods: [{ skillName: "Parachuting", mod: 2 }, { skillName: "Hang-Gliding", mod: 2 }] })], "hang-gliding").map(p => p.mod).join(","),
    listMiss: M.skillModProviders([mkMisc(true, { skillMods: [{ skillName: "Parachuting", mod: 2 }] })], "Athletics").length,
    group: M.gearModGroup([{ id: "abc", name: "Voc Decryptor", mod: 5, auto: false }])[0],
    groupNeg: M.gearModGroup([{ id: "x", name: "Bad Sight", mod: -1, auto: true }])[0].localKey,
    sum: M.gearModSum({ gearMod_a: true, gearMod_b: false }, [{ id: "a", mod: 2 }, { id: "b", mod: 5 }])
  };

  // ── (1) Corrections-wired base items (world copies; the preCreateItem chain) ──
  const impData = async (pack, id) => { const d = await game.packs.get(pack).getDocument(id); const it = await Item.create(game.items.fromCompendium(d)); const rm = foundry.utils.deepClone(it.system.mechRollMods); await it.delete(); return rm; };
  out.smart = await impData("cyberpunk2020.neuralware", "GWnQ3KQVL6PZpedS");   // Smartgun Link
  out.scope = await impData("cyberpunk2020.cyberoptic", "wO5L7J2iuRHjXI7d");   // Targeting Scope
  out.medsc = await impData("cyberpunk2020.medical", "oTl9WjtAxnwI2wly");      // Medscanner
  out.vocdec = await impData("cyberpunk2020.security", "oVGBBUXDnAph5s72");    // Voc Decryptor

  // ── (2) E2E: real dialogs on a real actor ─────────────────────────────────
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__RollMod"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__RollModPunk", type: "character" });
  const sheet = actor.sheet;

  // Smartgun Link imported onto the actor: ships Activatable+inactive → NO provider until switched on.
  const smartSrc = await game.packs.get("cyberpunk2020.neuralware").getDocument("GWnQ3KQVL6PZpedS");
  const [smart] = await actor.createEmbeddedDocuments("Item", [game.items.fromCompendium(smartSrc)]);
  out.e2eInactiveProviders = M.attackModProviders(actor.items).length;
  await smart.update({ "system.EffectActive": true });
  const activeProviders = M.attackModProviders(actor.items);
  out.e2eActiveProviders = activeProviders.length;

  const [gun] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__Pistol", type: "weapon",
    system: { weaponType: "Pistol", attackType: "SemiAuto", range: 50, shots: 10, shotsLeft: 10, rof: 1, accuracy: 0, attackSkill: "" } }]);

  // Fire dialog: the gear row renders pre-ticked; firing lands the +2 as a numeric roll term.
  const dlg = sheet._cpOpenWeaponAttackDialog(gun);
  await sleep(800);
  const rowSel = `input[name="gearMod_${smart.id}"]`;
  const row = dlg.element?.querySelector(rowSel);
  out.fireRow = { present: !!row, ticked: !!row?.checked,
    label: dlg.element?.querySelector(`${rowSel}`)?.closest(".field")?.querySelector("label")?.textContent?.trim() ?? "" };
  let before = new Set(game.messages.contents.map(m => m.id));
  dlg.element.querySelector("button.fire")?.click();
  await sleep(1500);
  let msgs = game.messages.contents.filter(m => !before.has(m.id));
  const hasTerm = (m, n) => (m.rolls ?? []).some(rl => (rl.terms ?? []).some(t => t.constructor?.name === "NumericTerm" && t.number === n));
  // The semi-auto card posts via Multiroll.execute() with NO addRoll → msg.rolls is [] on this
  // path (probe-verified 2026-07-06); the roll's term breakdown lives in the card MARKUP instead
  // (multi-hit.hbs renders numeric terms as `.roll-result.inactive` spans; the damage inline-roll
  // span lacks `inactive`, so it's excluded). The folded gear mod is the roll's LAST numeric term
  // by construction (extraMod is pushed last; accuracy 0 adds no term), so read that back.
  const lastNumericTermInCard = (m) => {
    const div = document.createElement("div");
    div.innerHTML = m.content ?? "";
    const nums = [...div.querySelectorAll(".roll-result.inactive")]
      .map(s => s.textContent.trim()).filter(t => /^-?\d+$/.test(t));
    return nums.length ? Number(nums[nums.length - 1]) : null;
  };
  out.fireRolled = { newMsgs: msgs.length,
    attachedRolls: msgs.length ? (msgs[msgs.length - 1].rolls ?? []).length : -1,
    lastTerm: msgs.length ? lastNumericTermInCard(msgs[msgs.length - 1]) : null };

  // Skill dialog: Medscanner (misc, correction-wired) + a Diagnose Illness skill with askMods OFF —
  // the provider alone opens the dialog; confirm lands +2; a second, unticked run lands nothing.
  const medSrc = await game.packs.get("cyberpunk2020.medical").getDocument("oTl9WjtAxnwI2wly");
  const [med] = await actor.createEmbeddedDocuments("Item", [game.items.fromCompendium(medSrc)]);
  await med.update({ "system.equipped": true });
  const [skill] = await actor.createEmbeddedDocuments("Item", [{ name: "Diagnose Illness", type: "skill", system: { level: 0 } }]);

  const sdlg = await sheet._cpRollSkillFromElement({ dataset: { skillId: skill.id } });
  await sleep(800);
  const srow = sdlg?.element?.querySelector(`input[name="gearMod_${med.id}"]`);
  out.skillRow = { opened: !!sdlg?.element, present: !!srow, ticked: !!srow?.checked };
  before = new Set(game.messages.contents.map(m => m.id));
  sdlg.element.querySelector('button[type="submit"]')?.click();
  await sleep(1500);
  msgs = game.messages.contents.filter(m => !before.has(m.id));
  out.skillRolled = { newMsgs: msgs.length, plus2: msgs.some(m => hasTerm(m, 2)) };

  const sdlg2 = await sheet._cpRollSkillFromElement({ dataset: { skillId: skill.id } });
  await sleep(800);
  const srow2 = sdlg2.element.querySelector(`input[name="gearMod_${med.id}"]`);
  srow2.checked = false;
  before = new Set(game.messages.contents.map(m => m.id));
  sdlg2.element.querySelector('button[type="submit"]')?.click();
  await sleep(1500);
  msgs = game.messages.contents.filter(m => !before.has(m.id));
  out.skillUnticked = { newMsgs: msgs.length, plus2: msgs.some(m => hasTerm(m, 2)) };

  // ── (3) Item-sheet block renders the wired values ─────────────────────────
  await med.sheet.render(true);
  await sleep(800);
  const iroot = med.sheet.element;
  out.sheetBlock = {
    enabled: !!iroot?.querySelector('input[name="system.mechRollMods.enabled"]')?.checked,
    skillName: iroot?.querySelector('input[name="system.mechRollMods.skillName"]')?.value ?? "",
    skillMod: iroot?.querySelector('input[name="system.mechRollMods.skillMod"]')?.value ?? ""
  };
  await med.sheet.close().catch(() => {});

  await actor.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["pure: disabled block → null", r.pure.disabledNull === true],
  ["pure: equipped misc +2 → one attack provider", r.pure.attackBasic.length === 1 && r.pure.attackBasic[0].mod === 2],
  ["pure: unequipped excluded", r.pure.unequipped === 0],
  ["pure: zero mod excluded", r.pure.zeroMod === 0],
  ["pure: Activatable cyberware off → excluded", r.pure.activatableOff === 0],
  ["pure: Activatable cyberware on → included", r.pure.activatableOn === 1],
  ["pure: chip without ChipActive → excluded", r.pure.chipInactive === 0],
  ["pure: chip with ChipActive → included", r.pure.chipActive === 1],
  ["pure: skill name matches case-insensitively", r.pure.skillMatch === 1],
  ["pure: skillMods list yields one row per matching entry", r.pure.listMatch === "2" && r.pure.listMiss === 0],
  ["pure: other skill → no provider", r.pure.skillMiss === 0],
  ["pure: group row shape (label / dataPath / unticked)", r.pure.group.localKey === "Voc Decryptor (+5)" && r.pure.group.dataPath === "gearMod_abc" && r.pure.group.defaultValue === false],
  ["pure: negative mod label", r.pure.groupNeg === "Bad Sight (-1)"],
  ["pure: sum counts only ticked rows", r.pure.sum === 2],
  ["corrections: Smartgun Link +2 attack, pre-ticked", r.smart?.enabled === true && r.smart?.attackMod === 2 && r.smart?.auto === true],
  ["corrections: Targeting Scope +1 attack", r.scope?.enabled === true && r.scope?.attackMod === 1],
  ["corrections: Medscanner +2 Diagnose Illness", r.medsc?.enabled === true && r.medsc?.skillName === "Diagnose Illness" && r.medsc?.skillMod === 2],
  ["corrections: Voc Decryptor +5 Electronic Security, NOT pre-ticked", r.vocdec?.skillMod === 5 && r.vocdec?.auto === false],
  ["e2e: inactive (Activatable off) link → no provider", r.e2eInactiveProviders === 0],
  ["e2e: activated link → one provider", r.e2eActiveProviders === 1],
  ["e2e: fire dialog shows the row pre-ticked", r.fireRow.present === true && r.fireRow.ticked === true],
  ["e2e: fire-dialog row label = name (+2)", /Smartgun Link \(\+2\)/.test(r.fireRow.label)],
  // UN-PARKED (2026-07-06): the earlier miss was a readback-location issue, not a lost modifier —
  // this card's message attaches NO rolls (Multiroll.execute without addRoll), so the term
  // breakdown is read from the card markup instead. Last numeric term = the folded gear mod.
  ["e2e: card markup term readback — folded mod is the last numeric term", r.fireRolled.newMsgs > 0 && r.fireRolled.lastTerm === 2],
  ["e2e: provider alone opens the skill dialog (askMods off)", r.skillRow.opened === true && r.skillRow.present === true && r.skillRow.ticked === true],
  ["e2e: confirmed skill roll carries the +2 term", r.skillRolled.newMsgs > 0 && r.skillRolled.plus2 === true],
  ["e2e: unticked row contributes nothing", r.skillUnticked.newMsgs > 0 && r.skillUnticked.plus2 === false],
  ["sheet: block renders wired values", r.sheetBlock.enabled === true && r.sheetBlock.skillName === "Diagnose Illness" && r.sheetBlock.skillMod === "2"],
  ["0 console errors", errors.length === 0]
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
