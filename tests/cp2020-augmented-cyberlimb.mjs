/** Cyberlimb SDP vs the human wound track (Core p.89). A hit to a cyberlimb zone reduces the limb's
 *  own SDP (system.sdp.current[zone]) instead of the character's wound track — no BTM, no stun/death
 *  save, no flesh limb-loss, no overflow; useless at ≤10 remaining, destroyed at ≤0. Flesh zones are
 *  unchanged. Runs on :30004 (official 1.1.1 + module). */
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
  const CL = await import("/modules/cp2020-augmented/module/mech/cyberlimb.js");
  const DA = await import("/modules/cp2020-augmented/module/combat/DamageApplicator.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  // ── (0) PURE ──────────────────────────────────────────────────────────────
  const A = (sum, cur) => ({ system: { sdp: { sum, current: cur } } });
  out.zone = {
    limbWithSdp: CL.isCyberlimbZone(A({ rArm: 30 }), "rArm"),
    limbNoSdp: CL.isCyberlimbZone(A({ rArm: 0 }), "rArm"),
    nonLimb: CL.isCyberlimbZone(A({ Torso: 99 }), "Torso")
  };
  out.status = { ok: CL.cyberlimbStatus(30), useless10: CL.cyberlimbStatus(10), useless5: CL.cyberlimbStatus(5), destroyed0: CL.cyberlimbStatus(0), destroyedNeg: CL.cyberlimbStatus(-4) };
  out.sdp = CL.cyberlimbSdp(A({ rArm: 30 }, { rArm: 12 }), "rArm");

  // ── (1) real actor with a right cyberarm ──────────────────────────────────
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Cyberlimb"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__CyberlimbPunk", type: "character" });
  await actor.update({ "system.damage": 0, "system.stats.bt.value": 5 });
  await actor.createEmbeddedDocuments("Item", [{ name: "__PW__RCyberarm", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent", cyberwareType: "CyberArm", MountZone: "Arm",
      CyberBodyType: { Type: "", Location: "Right" },
      CyberWorkType: { Type: "Implant", Types: ["Implant"], SDP: 30 } } }]);
  // poll for the base actor to sum the cyberlimb SDP into rArm
  for (let i = 0; i < 25 && (Number(actor.system?.sdp?.sum?.rArm) || 0) !== 30; i++) await sleep(200);
  const sumRArm = () => Number(actor.system?.sdp?.sum?.rArm) || 0;
  const curRArm = () => Number(actor.system?.sdp?.current?.rArm);
  const dmg = () => Number(actor.system?.damage) || 0;
  const limbStatus = () => actor.getFlag("cp2020-augmented", "limbStatus") ?? {};
  out.install = { sumRArm: sumRArm(), curRArm: curRArm(), wound: dmg() };

  const hit = (location, amount) => DA.applyAreaDamages({
    target: actor, areaDamages: { [location]: [{ damage: amount }] },
    ap: false, armorMode: DA.ARMOR_MODES.NONE, ablate: false, dryRun: false
  });

  // Cyberlimb hit → SDP down, wound track untouched, no limb-loss flag yet.
  await hit("rArm", 15); await sleep(500);
  out.clHit = { cur: curRArm(), wound: dmg(), status: limbStatus().rArm ?? null };  // cur 15, wound 0

  // Flesh control: a torso hit DOES advance the wound track.
  const woundBefore = dmg();
  await hit("Torso", 10); await sleep(500);
  out.fleshHit = { woundIncreased: dmg() > woundBefore, rArmUntouched: curRArm() === out.clHit.cur };

  // Useless: bring rArm to ≤ 10 remaining (15 - 6 = 9).
  await hit("rArm", 6); await sleep(500);
  out.useless = { cur: curRArm(), status: limbStatus().rArm };  // cur 9, "disabled"

  // Destroyed + no overflow + no death save: a huge hit (would be a Core >8 limb-loss death save on
  // flesh). Count death-save prompts to prove none fires on a cyberlimb. The destroyed STATE lives in
  // the sticky limbStatus flag (the base prep resets current back to sum when it reads exactly 0).
  const msgBefore = game.messages.size;
  const woundBeforeBig = dmg();
  await hit("rArm", 40); await sleep(600);
  // Scope the death-save scan to THIS fixture's speaker so a stray card can't masquerade as a cyberlimb
  // flesh death save.
  const newMsgs = game.messages.contents.slice(msgBefore).filter(m => m.speaker?.actor === actor.id).map(m => m.content || "");
  out.destroyed = {
    status: limbStatus().rArm,                                // "destroyed"
    noOverflow: dmg() === woundBeforeBig,                     // wound track NOT advanced
    noDeathSave: !newMsgs.some(c => /cp-death-save-roll|Death Save/.test(c))
  };

  // Re-hitting a destroyed limb soaks nothing and still routes nothing to the human.
  const woundBeforeRehit = dmg();
  await hit("rArm", 20); await sleep(400);
  out.reHit = { stillDestroyed: limbStatus().rArm === "destroyed", noOverflow: dmg() === woundBeforeRehit };

  // ── (2) Repair UI ─────────────────────────────────────────────────────────
  const sheetStatus = () => CL.cyberlimbSheetStatus(actor);
  out.repairBefore = { status: sheetStatus().rArm?.status, damaged: sheetStatus().rArm?.damaged };   // "destroyed", true
  // The sheet shows the true-status badge + a repair button on the destroyed limb.
  await actor.sheet.render(true); await sleep(900);
  const root = actor.sheet.element;
  // NOTE: the badge lives in `.segment-status-row` — its OWN row, a SIBLING of `.segment-sdp-row`
  // (armor-display.hbs put it there so "DESTROYED" can't collide with the SDP number boxes). The old
  // selector scoped it under `.segment-sdp-row` and could never match: a STALE-SELECTOR test bug, not
  // a product bug (repairBtn was true the whole time — the button renders fine).
  const badge = root?.querySelector(".segment-status-row .segment-limb-status.cp-limb-destroyed");
  const repairBtn = root?.querySelector('.cp-cyberlimb-repair[data-zone="rArm"]');
  out.sheetUI = { badge: !!badge, badgeText: badge?.textContent?.trim() ?? "", repairBtn: !!repairBtn };
  await actor.sheet.close().catch(() => {});
  // Repair restores SDP to full and clears the sticky flag.
  await CL.repairCyberlimb(actor, "rArm"); await sleep(500);
  out.repaired = { cur: curRArm(), flag: limbStatus().rArm ?? null, status: sheetStatus().rArm?.status ?? "gone" };  // 30, null, "ok"

  // ── (3) M19 zone gate + notice ────────────────────────────────────────────
  // A mod source installed IN the right arm (side resolved through its parent — no own Location).
  const [armTool] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__ArmToolMod", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent", MountZone: "Arm",
      CyberBodyType: { Type: "", Location: "" },
      Module: { IsModule: true, ParentId: actor.items.find(i => i.name === "__PW__RCyberarm").id, SlotsTaken: 1 },
      mechRollMods: { enabled: true, attackMod: 0, skillName: "Awareness", skillMod: 2, auto: true } } }]);
  await sleep(400);
  const itemsNow = () => actor.items.contents;
  out.zoneResolve = {
    viaParent: CL.implantZoneOf(armTool, itemsNow()),                       // "rArm" (parent's side)
    zoneless: CL.implantZoneOf({ type: "cyberware", system: { MountZone: "Nervous" } }, []),  // ""
    nonCw: CL.inDestroyedZone(actor, { type: "misc", system: {} }, itemsNow())                // false
  };
  // Intact limb: the source is in the contributing list + reaches the provider builder.
  const RM = await import("/modules/cp2020-augmented/module/mech/roll-mods.js");
  const inList = () => CL.contributingItems(actor).some(i => i.id === armTool.id);
  const inProviders = () => RM.skillModProviders(CL.contributingItems(actor), "Awareness").some(p => p.id === armTool.id);
  out.gateIntact = { inList: inList(), inProviders: inProviders() };
  // Negative case first: with both arms OK, the use event posts NO zone-state card.
  const noticeBodyFor = (state) => game.i18n.format("CYBERPUNK.CyberlimbArmNoticeBody", {
    name: actor.name, limb: game.i18n.localize("CYBERPUNK.rArm"),
    state: game.i18n.localize(state === "destroyed" ? "CYBERPUNK.CyberlimbStatusDestroyed" : "CYBERPUNK.CyberlimbStatusUseless") });
  const noticeCount = (since, state) => game.messages.contents.slice(since).filter(m => (m.content || "").includes(noticeBodyFor(state))).length;
  const q1 = game.messages.size;
  Hooks.callAll("cyberpunk2020.weaponFired", { attackerId: actor.id, areaDamages: {} });
  await sleep(600);
  out.noticeIntact = { cards: noticeCount(q1, "destroyed") + noticeCount(q1, "useless") };
  // Zone destroyed: the gate flips everywhere off one filter; the strip mirrors it.
  await hit("rArm", 40); await sleep(500);
  const ST = await import("/modules/cp2020-augmented/module/mech/status.js");
  out.gateWrecked = {
    zoneState: limbStatus().rArm,                                            // "destroyed"
    inList: inList(), inProviders: inProviders(),                            // false, false
    stripRow: ST.activeInfluencesFor(actor).some(rw => rw.itemId === armTool.id)  // false
  };
  // The use event now posts the zone-state card exactly once.
  const q2 = game.messages.size;
  Hooks.callAll("cyberpunk2020.weaponFired", { attackerId: actor.id, areaDamages: {} });
  await sleep(600);
  out.noticeWrecked = { cards: noticeCount(q2, "destroyed") };
  // Repair lifts the gate — the source contributes again.
  await CL.repairCyberlimb(actor, "rArm"); await sleep(500);
  out.gateRepaired = { inList: inList(), inProviders: inProviders() };

  await actor.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["pure: isCyberlimbZone (limb+SDP yes; no-SDP no; non-limb no)", r.zone.limbWithSdp === true && r.zone.limbNoSdp === false && r.zone.nonLimb === false],
  ["pure: status ok/useless/destroyed bands", r.status.ok === "ok" && r.status.useless10 === "useless" && r.status.useless5 === "useless" && r.status.destroyed0 === "destroyed" && r.status.destroyedNeg === "destroyed"],
  ["pure: cyberlimbSdp reads {max,current}", r.sdp.max === 30 && r.sdp.current === 12],
  ["install: right cyberarm sums 30 SDP into rArm, current 30, wound 0", r.install.sumRArm === 30 && r.install.curRArm === 30 && r.install.wound === 0],
  ["cyberlimb hit reduces SDP (30→15), wound track stays 0", r.clHit.cur === 15 && r.clHit.wound === 0 && r.clHit.status === null],
  ["flesh torso hit advances the wound track (cyberarm untouched)", r.fleshHit.woundIncreased === true && r.fleshHit.rArmUntouched === true],
  ["useless at ≤10 remaining (9) → limb disabled", r.useless.cur === 9 && r.useless.status === "disabled"],
  ["destroyed → limb flagged destroyed, NO overflow to the wound track", r.destroyed.status === "destroyed" && r.destroyed.noOverflow === true],
  ["a limb-destroying hit fires NO death save (RAW: machinery)", r.destroyed.noDeathSave === true],
  ["re-hitting a destroyed limb soaks nothing + no wound overflow", r.reHit.stillDestroyed === true && r.reHit.noOverflow === true],
  ["repair UI: destroyed limb reports the true status (not the reset SDP number)", r.repairBefore.status === "destroyed" && r.repairBefore.damaged === true],
  ["repair UI: sheet shows the destroyed badge + repair button", r.sheetUI.badge === true && /destroyed/i.test(r.sheetUI.badgeText) && r.sheetUI.repairBtn === true],
  ["repair restores SDP to full + clears the destroyed flag", r.repaired.cur === 30 && r.repaired.flag === null && r.repaired.status === "ok"],
  ["M19 zone resolution: parent-side resolve, zoneless mount, non-cyberware exempt", r.zoneResolve.viaParent === "rArm" && r.zoneResolve.zoneless === "" && r.zoneResolve.nonCw === false],
  ["M19 gate intact: in-zone source contributes (list + provider row)", r.gateIntact.inList === true && r.gateIntact.inProviders === true],
  ["M19 notice negative: no zone-state card while both arms are ok", r.noticeIntact.cards === 0],
  ["M19 gate wrecked: destroyed zone drops the source from list, providers, and strip", r.gateWrecked.zoneState === "destroyed" && r.gateWrecked.inList === false && r.gateWrecked.inProviders === false && r.gateWrecked.stripRow === false],
  ["M19 notice: the use event posts the zone-state card exactly once", r.noticeWrecked.cards === 1],
  ["M19 repair lifts the gate: the source contributes again", r.gateRepaired.inList === true && r.gateRepaired.inProviders === true],
  ["0 console errors", errors.length === 0]
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
