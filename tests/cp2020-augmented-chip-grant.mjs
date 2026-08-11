/** Q2 chip skill grants (SPECIAL-MECHANICS-PROPOSAL.md §3b): the pure parse/resolve helpers, the
 *  fixed-skill grant→override→prune lifecycle on a real actor, the choose-chip prompt+rewrite (real
 *  dialog), the reset, and the trained-skill keep-on-deactivate case. */
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
  const G = await import("/modules/cp2020-augmented/module/mech/chip-grant.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  // Wait on the grant/prune hook's OBSERVABLE result instead of a fixed sleep.
  const waitUntil = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await sleep(100); } return false; };
  const realVal = (skill) => {
    const d = skill.system;
    return (d.isChipped || d.autoChipped) ? (Number(d.chipLevel) || 0) : (Number(d.level) || 0);
  };

  // ── (0) PURE ────────────────────────────────────────────────────────────
  out.parse = {
    plain: G.parseChooseKey("Botany"),
    bare: G.parseChooseKey("(choose)"),
    lang: G.parseChooseKey("(choose:Language)"),
    martial: G.parseChooseKey("(choose:Martial Art)")
  };
  const chip = (over, chipSkills) => ({ type: "cyberware", name: "C",
    system: { equipped: true, EffectMode: "Permanent", EffectActive: false,
      CyberWorkType: { Types: ["Chip"], ChipActive: true, ChipSkills: chipSkills }, ...over } });
  out.pureEngine = {
    activeChip: G.isActiveChip(chip({}, { Botany: 3 })),
    inactiveChip: G.isActiveChip(chip({ CyberWorkType: { Types: ["Chip"], ChipActive: false, ChipSkills: { Botany: 3 } } }, {})),
    unequipped: G.isActiveChip(chip({ equipped: false }, { Botany: 3 })),
    grants: G.resolvedGrantsFor([chip({}, { Botany: 3, "(choose:Language)": 2 })]),   // choose skipped
    grantsMaxLevel: G.resolvedGrantsFor([chip({}, { Botany: 2 }), chip({}, { Botany: 4 })]),
    unresolvedKeys: G.unresolvedChooseKeys(chip({}, { "(choose:Martial Art)": 3, Botany: 1 })),
    hasSkill: G.actorHasSkill([{ type: "skill", name: "Botany" }], "Botany"),
    lacksSkill: G.actorHasSkill([{ type: "skill", name: "Botany" }], "Space Survival")
  };

  // ── (1) Fixed-skill grant lifecycle on a real actor ───────────────────────
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Chip"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__ChipPunk", type: "character" });
  const [space] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__SpaceChip", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent", EffectActive: false,
      CyberWorkType: { Types: ["Chip"], ChipActive: false, ChipSkills: { "Space Survival": 2, "Highrider Culture": 1 }, Stat: {}, Skill: {} } } }]);

  const skillNamed = (n) => actor.items.find(i => i.type === "skill" && i.name === n);
  out.beforeGrant = { hasSpace: !!skillNamed("Space Survival") };

  await space.update({ "system.CyberWorkType.ChipActive": true });
  await waitUntil(() => !!skillNamed("Space Survival") && !!skillNamed("Highrider Culture"));
  const spaceSkill = skillNamed("Space Survival");
  const cultureSkill = skillNamed("Highrider Culture");
  out.granted = {
    spaceCreated: !!spaceSkill,
    cultureCreated: !!cultureSkill,
    spaceFlag: !!spaceSkill?.getFlag("cp2020-augmented", "chipGranted"),
    spaceNaturalZero: (Number(spaceSkill?.system?.level) || 0) === 0,
    spaceEffective: spaceSkill ? realVal(spaceSkill) : null,      // base override → chip level 2
    cultureEffective: cultureSkill ? realVal(cultureSkill) : null
  };

  await space.update({ "system.CyberWorkType.ChipActive": false });
  await waitUntil(() => !skillNamed("Space Survival") && !skillNamed("Highrider Culture"));
  out.deactivated = {
    spaceGone: !skillNamed("Space Survival"),
    cultureGone: !skillNamed("Highrider Culture")
  };

  // Re-activate, then TRAIN one granted skill, then deactivate → the trained one is kept + unflagged.
  await space.update({ "system.CyberWorkType.ChipActive": true });
  await waitUntil(() => !!skillNamed("Space Survival"));
  const reSpace = skillNamed("Space Survival");
  await reSpace.update({ "system.level": 3 }); await sleep(400);
  await space.update({ "system.CyberWorkType.ChipActive": false });
  await waitUntil(() => !skillNamed("Highrider Culture"));   // untrained sibling pruned; the trained one survives
  const keptSpace = skillNamed("Space Survival");
  out.trainedKept = {
    spaceKept: !!keptSpace,
    spaceLevel: Number(keptSpace?.system?.level) || 0,
    flagCleared: keptSpace ? keptSpace.getFlag("cp2020-augmented", "chipGranted") === undefined : null,
    cultureGone: !skillNamed("Highrider Culture")   // untrained sibling still removed
  };
  await keptSpace?.delete().catch(() => {});
  await space.delete().catch(() => {});

  // ── (1b) id-form keys · gate axes beyond ChipActive · IP-preserving prune ─
  // The sheets write skill-item _IDs as ChipSkills keys (the packs write names): an id key must
  // grant the NAMED skill, not a skill named the raw id. The running gate is three-axis, so an
  // unequip (ChipActive untouched) prunes like a deactivation; accrued IP counts as trained.
  const U = await import("/modules/cp2020-augmented/module/utils.js");
  const skillIdx = await U.getSkillIndex();
  // Pick an index skill the actor LACKS: a fresh character is pre-populated with the default
  // skill set, and an id key for a skill it already HAS grants nothing (that's correct engine
  // behavior) — the leg must exercise the CREATE path.
  const actorSkillNames = new Set(actor.items.filter(i => i.type === "skill").map(i => i.name));
  const idxEntry = skillIdx.find(e => !actorSkillNames.has(e.name)) ?? skillIdx[0];
  const [idChip] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__IdChip", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent", EffectActive: false,
      CyberWorkType: { Types: ["Chip"], ChipActive: false,
        ChipSkills: { [idxEntry.id]: 2, "Highrider Culture": 1 }, Stat: {}, Skill: {} } } }]);
  await idChip.update({ "system.CyberWorkType.ChipActive": true });
  await waitUntil(() => !!skillNamed(idxEntry.name));
  const idGrant = skillNamed(idxEntry.name);
  out.idKey = {
    indexName: idxEntry.name,
    created: !!idGrant,
    noJunkIdSkill: !skillNamed(idxEntry.id),
    flagged: !!idGrant?.getFlag("cp2020-augmented", "chipGranted"),
    untrainedSibling: !!skillNamed("Highrider Culture")
  };

  await idGrant?.update({ "system.ip": 5 }); await sleep(400);
  await idChip.update({ "system.equipped": false });   // gate axis: equipped, not ChipActive
  await waitUntil(() => !skillNamed("Highrider Culture"));
  const ipKept = skillNamed(idxEntry.name);
  out.unequipPrune = {
    ipKept: !!ipKept,
    ip: Number(ipKept?.system?.ip) || 0,
    flagCleared: ipKept ? ipKept.getFlag("cp2020-augmented", "chipGranted") === undefined : null,
    untrainedGone: !skillNamed("Highrider Culture")
  };
  await ipKept?.delete().catch(() => {});
  await idChip.delete().catch(() => {});

  // ── (2) Choose-chip: activate → real dialog → rewrite + grant ─────────────
  const [lang] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__LangChip", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent", EffectActive: false,
      CyberWorkType: { Types: ["Chip"], ChipActive: false, ChipSkills: { "(choose:Language)": 2 }, Stat: {}, Skill: {} } } }]);
  lang.update({ "system.CyberWorkType.ChipActive": true });   // fire-and-poll (the hook awaits the dialog)
  let input = null;
  for (let i = 0; i < 50 && !input; i++) { await sleep(200); input = document.querySelector('.cp-chip-choose input[name="skill"]'); }
  out.choosePromptShown = !!input;
  if (input) {
    input.value = "Language: Spanish";
    const ok = [...document.querySelectorAll("button")].find(bt => /Slot chip/i.test(bt.textContent));
    ok?.click();
    await sleep(1800);
  }
  const langNow = actor.items.get(lang.id);
  const spanishSkill = actor.items.find(i => i.type === "skill" && i.name === "Language: Spanish");
  const cs = langNow?.system?.CyberWorkType?.ChipSkills ?? {};
  out.chooseResolved = {
    chipSkillsRaw: JSON.stringify(cs),
    chipSkillsRewritten: Object.prototype.hasOwnProperty.call(cs, "Language: Spanish") && !Object.prototype.hasOwnProperty.call(cs, "(choose:Language)"),
    skillGranted: !!spanishSkill,
    skillEffective: spanishSkill ? realVal(spanishSkill) : null,
    originalStashed: langNow?.getFlag("cp2020-augmented", "chipChooseOriginal") !== undefined
  };

  // Reset restores the "(choose:Language)" marker (and drops the resolved skill on next prune).
  const { resetChipChoice } = G;
  await resetChipChoice(langNow); await sleep(400);
  const langAfterReset = actor.items.get(lang.id);
  out.reset = {
    markerRestored: !!langAfterReset?.system?.CyberWorkType?.ChipSkills?.["(choose:Language)"],
    resolvedGone: !langAfterReset?.system?.CyberWorkType?.ChipSkills?.["Language: Spanish"],
    flagCleared: langAfterReset?.getFlag("cp2020-augmented", "chipChooseOriginal") === undefined
  };

  await actor.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["pure: plain key is not a choose", r.parse.plain.choose === false],
  ["pure: (choose) parses, no category", r.parse.bare.choose === true && r.parse.bare.category === ""],
  ["pure: (choose:Language) parses the category", r.parse.lang.choose === true && r.parse.lang.category === "Language"],
  ["pure: (choose:Martial Art) parses the category", r.parse.martial.category === "Martial Art"],
  ["pure: active chip detected; inactive/unequipped excluded", r.pureEngine.activeChip === true && r.pureEngine.inactiveChip === false && r.pureEngine.unequipped === false],
  ["pure: resolved grants skip choose keys", r.pureEngine.grants.Botany === 3 && r.pureEngine.grants["(choose:Language)"] === undefined],
  ["pure: grants take the max level across chips", r.pureEngine.grantsMaxLevel.Botany === 4],
  ["pure: unresolved choose keys listed", r.pureEngine.unresolvedKeys.length === 1 && r.pureEngine.unresolvedKeys[0].category === "Martial Art" && r.pureEngine.unresolvedKeys[0].level === 3],
  ["pure: actorHasSkill matches by name", r.pureEngine.hasSkill === true && r.pureEngine.lacksSkill === false],
  ["e2e: actor lacks the granted skill beforehand", r.beforeGrant.hasSpace === false],
  ["e2e: activation creates the missing skills (flagged, natural 0)", r.granted.spaceCreated === true && r.granted.cultureCreated === true && r.granted.spaceFlag === true && r.granted.spaceNaturalZero === true],
  ["e2e: base override drives the granted skills to chip level", r.granted.spaceEffective === 2 && r.granted.cultureEffective === 1],
  ["e2e: deactivation removes the untrained granted skills", r.deactivated.spaceGone === true && r.deactivated.cultureGone === true],
  ["e2e: a trained granted skill survives deactivation (flag cleared)", r.trainedKept.spaceKept === true && r.trainedKept.spaceLevel === 3 && r.trainedKept.flagCleared === true && r.trainedKept.cultureGone === true],
  ["id-key: an id-form ChipSkills key grants the NAMED skill (no raw-id skill created)", r.idKey.created === true && r.idKey.noJunkIdSkill === true && r.idKey.flagged === true && r.idKey.untrainedSibling === true],
  ["gate: unequip alone runs the prune (untrained granted skill removed)", r.unequipPrune.untrainedGone === true],
  ["prune: accrued IP counts as trained (kept, flag dropped, IP intact)", r.unequipPrune.ipKept === true && r.unequipPrune.ip === 5 && r.unequipPrune.flagCleared === true],
  ["choose: activation shows the pick-a-skill dialog", r.choosePromptShown === true],
  ["choose: the pick rewrites ChipSkills + grants the skill at chip level", r.chooseResolved.chipSkillsRewritten === true && r.chooseResolved.skillGranted === true && r.chooseResolved.skillEffective === 2 && r.chooseResolved.originalStashed === true],
  ["reset: restores the (choose) marker + clears the stash", r.reset.markerRestored === true && r.reset.resolvedGone === true && r.reset.flagCleared === true],
  ["0 console errors", errors.length === 0]
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
