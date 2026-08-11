/** §3c visibility hybrid (SPECIAL-MECHANICS-PROPOSAL.md): the status-strip aggregator's pure row
 *  tables, the actor-sheet render (strip pills + stat tooltips + item-row badges), the quick-off
 *  toggle round-trip, and the timer token-icon lifecycle (created on use, pruned at wear-off). */
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
  const S = await import("/modules/cp2020-augmented/module/mech/status.js");
  const C = await import("/modules/cp2020-augmented/module/mech/consumable.js");
  const SCOPE = "cp2020-augmented";
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  // ── (0) PURE truth tables over plain item shapes ───────────────────────────
  const mkMisc = (over = {}, sys = {}) => ({ id: "m1", type: "misc", name: "Widget",
    system: { equipped: true, ...sys }, ...over });
  const mkCyber = (sys = {}) => ({ id: "c1", type: "cyberware", name: "Chrome",
    system: { equipped: true, EffectMode: "Permanent", EffectActive: false,
      CyberWorkType: { Types: [], ChipActive: false }, ...sys } });

  out.toggle = {
    misc: S.quickTogglePathOf(mkMisc()),
    chip: S.quickTogglePathOf(mkCyber({ CyberWorkType: { Types: ["Chip"], ChipActive: true } })),
    activatable: S.quickTogglePathOf(mkCyber({ EffectMode: "Activatable" })),
    permanent: S.quickTogglePathOf(mkCyber())
  };

  const lit = mkMisc({}, { mechLight: { enabled: true, on: true, shape: "cone", bright: 3, dim: 6, angle: 45, color: "" } });
  const unequippedLit = mkMisc({}, { equipped: false, mechLight: { enabled: true, on: true, shape: "cone", bright: 3, dim: 6 } });
  out.light = {
    row: S.lightRows([lit])[0] ?? null,
    unequippedExcluded: S.lightRows([unequippedLit]).length
  };

  const viewing = mkMisc({}, { mechVision: { enabled: true, on: true, mode: "infrared", range: 30 } });
  out.vision = { row: S.visionRows([viewing])[0] ?? null };

  const maskMisc = mkMisc({}, { mechProtection: { enabled: true, gas: { immune: true, mod: 0 }, flash: { immune: false, mod: 0 }, sonic: { immune: false, mod: 0 } } });
  const protCyber = mkCyber({ mechProtection: { enabled: true, flash: { immune: true, mod: 0 }, gas: { immune: false, mod: 0 }, sonic: { immune: false, mod: 0 } } });
  const protCyberRow = S.protectionRows([protCyber])[0] ?? null;
  out.protection = {
    miscRow: S.protectionRows([maskMisc])[0] ?? null,
    cyberRowExists: !!protCyberRow,
    cyberToggleIsNull: !!protCyberRow && protCyberRow.togglePath === null
  };

  const chipOn = mkCyber({ CyberWorkType: { Types: ["Chip"], ChipActive: true, ChipSkills: { Botany: 3 } } });
  const chipOff = mkCyber({ CyberWorkType: { Types: ["Chip"], ChipActive: false, ChipSkills: { Botany: 3 } } });
  out.chip = {
    row: S.chipRows([chipOn])[0] ?? null,
    inactiveExcluded: S.chipRows([chipOff]).length
  };

  const statImp = mkCyber({ CyberWorkType: { Types: ["Characteristic"], Stat: { ref: 1 } } });
  const statImpOff = mkCyber({ EffectMode: "Activatable", EffectActive: false, CyberWorkType: { Types: ["Characteristic"], Stat: { ref: 1 } } });
  out.stat = {
    row: S.statRows([statImp])[0] ?? null,
    inactiveExcluded: S.statRows([statImpOff]).length
  };

  const skillImp = mkCyber({ CyberWorkType: { Types: ["Characteristic"], Skill: { "Awareness/Notice": 1 } } });
  out.skill = { row: S.skillRows([skillImp])[0] ?? null };

  const rollTool = mkMisc({}, { mechRollMods: { enabled: true, attackMod: 0, skillName: "Diagnose Illness", skillMod: 2, auto: true } });
  const rollZero = mkMisc({}, { mechRollMods: { enabled: true, attackMod: 0, skillName: "", skillMod: 0, auto: true } });
  out.roll = {
    row: S.rollModRows([rollTool])[0] ?? null,
    zeroExcluded: S.rollModRows([rollZero]).length
  };

  out.timers = S.timerRows({ flags: { [SCOPE]: { consumableState: [{ itemId: "x", name: "Dose", note: "+1 REF", turnsLeft: 2 }] } } })[0] ?? null;

  // ── (1) E2E: real actor, real sheet ────────────────────────────────────────
  // Pre-clean a leftover ACTIVE combat from a crashed prior run (it would feed per-turn hooks here).
  for (const c of [...game.combats].filter(c => c.combatants.some(cb => cb.actor?.name?.startsWith("__PW__")))) await c.delete().catch(() => {});
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__VisPunk"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__VisPunk", type: "character" });

  const mk = async (data) => (await actor.createEmbeddedDocuments("Item", [data]))[0];
  const litItem = await mk({ name: "__PW__Handlight", type: "misc", system: { equipped: true,
    mechLight: { enabled: true, on: true, shape: "cone", bright: 3, dim: 6, angle: 45, color: "" } } });
  const inertItem = await mk({ name: "__PW__PlainThing", type: "misc", system: { equipped: true } });
  const statItem = await mk({ name: "__PW__RefBooster", type: "cyberware", system: { equipped: true,
    EffectMode: "Permanent", CyberWorkType: { Types: ["Characteristic"], Stat: { ref: 1 }, Skill: {}, ChipSkills: {} } } });
  const chipItem = await mk({ name: "__PW__BotanyChip", type: "cyberware", system: { equipped: true,
    EffectMode: "Permanent", CyberWorkType: { Types: ["Chip"], ChipActive: true, ChipSkills: { Botany: 3 }, Stat: {}, Skill: {} } } });

  const sheet = actor.sheet;
  await sheet.render(true); await sleep(900);
  let root = sheet.element;
  const pillsOf = () => [...(sheet.element?.querySelectorAll(".cp-status-strip .cp-status-pill") ?? [])];
  const kindsOf = () => pillsOf().map(el => [...el.classList].find(c => c.startsWith("cp-kind-"))?.slice(8));

  out.strip = {
    pillCount: pillsOf().length,
    kinds: kindsOf().sort(),
    statPillHasNoOff: !pillsOf().some(el => el.classList.contains("cp-kind-stat") && el.querySelector(".cp-pill-off")),
    lightPillHasOff: pillsOf().some(el => el.classList.contains("cp-kind-light") && el.querySelector(".cp-pill-off")),
    statPillText: pillsOf().find(el => el.classList.contains("cp-kind-stat"))?.textContent?.replace(/\s+/g, " ").trim() ?? ""
  };

  const refTip = root?.querySelector('.stat-total[data-stat-name="ref"]')?.getAttribute("title") ?? "";
  out.tooltip = { refTip, named: refTip.includes("__PW__RefBooster"), shape: /=\s*\d+/.test(refTip) || /^\d+\s*=/.test(refTip) };

  const badgeOn = !!root?.querySelector(`[data-item-id="${litItem.id}"] .cp-active-badge`);
  const badgeOffInert = !!root?.querySelector(`[data-item-id="${inertItem.id}"] .cp-active-badge`);
  const badgeOnCyber = !!root?.querySelector(`[data-item-id="${statItem.id}"] .cp-active-badge`);
  out.badges = { litRow: badgeOn, inertRow: badgeOffInert, cyberRow: badgeOnCyber };

  // Quick-off round-trip: the light pill's × switches mechLight.on off; the pill leaves the strip.
  pillsOf().find(el => el.classList.contains("cp-kind-light"))?.querySelector(".cp-pill-off")?.click();
  await sleep(1200);
  out.quickOff = {
    lightOff: litItem.system.mechLight.on === false,
    pillGone: !kindsOf().includes("light")
  };

  // ── (2) Timer row + token icon lifecycle ───────────────────────────────────
  const doseItem = await mk({ name: "__PW__Stim", type: "misc", system: { equipped: true,
    mechConsumable: { enabled: true, doses: 2, durationTurns: "2", note: "test effect" } } });
  await C.useConsumable(doseItem); await sleep(1000);
  const icon = (actor.effects?.contents ?? []).find(e => e.getFlag(SCOPE, "consumableItemId") === doseItem.id);
  out.timerStart = {
    marker: (actor.getFlag(SCOPE, "consumableState") ?? [])[0]?.turnsLeft ?? null,
    pill: kindsOf().includes("timer"),
    iconExists: !!icon,
    // Read the SOURCE duration — the prepared duration object is normalized against the (absent)
    // combat and reports null rounds (same _source discipline the mech engines use for snapshots).
    iconRounds: icon?._source?.duration?.rounds ?? null,
    iconInert: (icon?.changes ?? []).length === 0
  };

  // Combat is active:true — tear it down in finally so a mid-run throw never leaks an active combat.
  let scene = null, tok = null, combat = null;
  try {
  scene = game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
  [tok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__VisPunk", actorId: actor.id, actorLink: true, x: 800, y: 800 }]);
  combat = await Combat.create({ scene: scene.id, active: true });
  await combat.createEmbeddedDocuments("Combatant", [{ tokenId: tok.id, actorId: actor.id }]);
  await combat.startCombat(); await sleep(1000);
  await combat.update({ round: 2, turn: 0 }); await sleep(1200);
  await combat.update({ round: 3, turn: 0 }); await sleep(1500);
  out.timerExpiry = {
    flagCleared: !actor.getFlag(SCOPE, "consumableState"),
    iconPruned: !(actor.effects?.contents ?? []).some(e => e.getFlag(SCOPE, "consumableItemId"))
  };

  } finally {
    if (combat) await combat.delete().catch(() => {});
    if (scene && tok) await scene.deleteEmbeddedDocuments("Token", [tok.id]).catch(() => {});
  }
  await sheet.close().catch(() => {});
  await actor.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["pure: quick-off path — misc → equipped", r.toggle.misc === "system.equipped"],
  ["pure: quick-off path — chip → ChipActive", r.toggle.chip === "system.CyberWorkType.ChipActive"],
  ["pure: quick-off path — Activatable → EffectActive", r.toggle.activatable === "system.EffectActive"],
  ["pure: quick-off path — permanent implant → none", r.toggle.permanent === null],
  ["pure: emitter row carries range + toggle path", r.light.row?.detail?.range === 6 && r.light.row?.togglePath === "system.mechLight.on"],
  ["pure: unequipped emitter excluded", r.light.unequippedExcluded === 0],
  ["pure: vision row carries mode + range + governs", r.vision.row?.detail?.mode === "infrared" && r.vision.row?.detail?.range === 30 && r.vision.row?.detail?.governs === true],
  ["pure: protection misc row — hazard entry + unequip toggle", r.protection.miscRow?.detail?.hazards?.[0]?.hazard === "gas" && r.protection.miscRow?.detail?.hazards?.[0]?.immune === true && r.protection.miscRow?.togglePath === "system.equipped"],
  ["pure: protection cyberware row is display-only", r.protection.cyberRowExists === true && r.protection.cyberToggleIsNull === true],
  ["pure: chip row lists skill + level", r.chip.row?.detail?.skills?.[0]?.name === "Botany" && r.chip.row?.detail?.skills?.[0]?.level === 3],
  ["pure: inactive chip excluded", r.chip.inactiveExcluded === 0],
  ["pure: stat row lists stat + mod", r.stat.row?.detail?.stats?.[0]?.stat === "ref" && r.stat.row?.detail?.stats?.[0]?.mod === 1],
  ["pure: switched-off Activatable stat source excluded", r.stat.inactiveExcluded === 0],
  ["pure: skill payload row lists name + mod", r.skill.row?.detail?.skills?.[0]?.name === "Awareness/Notice" && r.skill.row?.detail?.skills?.[0]?.mod === 1],
  ["pure: roll-mod row carries skill mod", r.roll.row?.detail?.skillMod === 2 && r.roll.row?.detail?.skillName === "Diagnose Illness"],
  ["pure: zero-mod provider excluded", r.roll.zeroExcluded === 0],
  ["pure: timer row reads the marker flag", r.timers?.detail?.turnsLeft === 2 && r.timers?.togglePath === null],
  ["e2e: strip renders one pill per active influence", r.strip.pillCount === 3 && JSON.stringify(r.strip.kinds) === JSON.stringify(["chip", "light", "stat"])],
  ["e2e: permanent-implant pill has no quick-off; emitter pill has one", r.strip.statPillHasNoOff === true && r.strip.lightPillHasOff === true],
  ["e2e: stat pill names the source + contribution", /__PW__RefBooster/.test(r.strip.statPillText) && /REF \+1/.test(r.strip.statPillText)],
  ["e2e: stat tooltip names the contributing item in a breakdown", r.tooltip.named === true && r.tooltip.shape === true],
  ["e2e: active rows badge, inert rows don't", r.badges.litRow === true && r.badges.inertRow === false && r.badges.cyberRow === true],
  ["e2e: quick-off writes the advertised path + pill leaves the strip", r.quickOff.lightOff === true && r.quickOff.pillGone === true],
  ["e2e: timer start — marker + strip pill + inert token icon (rounds set)", r.timerStart.marker === 2 && r.timerStart.pill === true && r.timerStart.iconExists === true && r.timerStart.iconRounds === 2 && r.timerStart.iconInert === true],
  ["e2e: wear-off prunes the token icon with the marker", r.timerExpiry.flagCleared === true && r.timerExpiry.iconPruned === true],
  ["0 console errors", errors.length === 0]
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
