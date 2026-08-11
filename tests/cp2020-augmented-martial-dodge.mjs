/**
 * Declared-dodge style bonus (CP2020 melee defense, Core p.100/102). :30004 (official 1.1.1 + module).
 *
 * A declared dodge adds a generic +2 to the defender's opposed roll (the book's "-2 to attacker" stance,
 * available to anyone) PLUS, additively (user ruling), the defender's martial-style Dodge key-attack
 * bonus (Aikido 3, etc.). The key comes from the SAME art rollMeleeDefense chose for the roll — never a
 * non-chosen skill's level combined with another art's key (the anti-composition guard the user asked for).
 *
 *   FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node tests/cp2020-augmented-martial-dodge.mjs
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
  const MA = await import("/modules/cp2020-augmented/module/martial/martial.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  const SCOPE = "cp2020-augmented";
  const martial = (name, level, bonuses) => ({ name, type: "skill", system: { level }, flags: { [SCOPE]: { isMartialArt: true, martialBonuses: bonuses } } });

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Dodge"))) await a.delete().catch(() => {});
  // A fresh character auto-seeds the standard skill list, so a non-martial candidate (Athletics/Melee/…)
  // must be UPDATED in place, not duplicated — getSkillVal returns the first match, so a duplicate would
  // be shadowed by the seeded level-0 one. Unique-named custom arts have no such collision.
  const setSkill = async (a, name, level) => {
    const ex = a.itemTypes.skill.find(s => s.name === name);
    if (ex) await ex.update({ "system.level": level });
    else await a.createEmbeddedDocuments("Item", [{ name, type: "skill", system: { level } }]);
  };
  const mk = async (name, { arts = [], skills = {}, dodging = false } = {}) => {
    const a = await Actor.create({ name, type: "character" });
    await a.update({ "system.stats.ref.base": 6 });   // ref.total derives from .base, not .value
    for (const [n, lvl] of Object.entries(skills)) await setSkill(a, n, lvl);
    if (arts.length) await a.createEmbeddedDocuments("Item", arts);
    if (dodging) await a.setFlag(SCOPE, "dodging", true);
    await sleep(150);
    return a;
  };

  // ── (A) rollMeleeDefense: dodge key selection + reporting (deterministic, no dice dependence) ──
  // A trained art's Dodge key rides on THAT art's roll only. Aikido=Dodge3, Karate=no Dodge entry.
  const aikido  = await mk("__PW__DodgeAikido",  { arts: [martial("TestAikido", 5, { Dodge: 3, BlockParry: 4 })], dodging: true });
  const karate  = await mk("__PW__DodgeKarate",  { arts: [martial("TestKarate", 5, { Strike: 2, Kick: 2 })], dodging: true });
  const nonMart = await mk("__PW__DodgeAthlete", { skills: { Athletics: 6 }, dodging: true });
  // MIXED: a higher-level NON-martial skill outranks a low art's level+key → the art's key must NOT be
  // credited alongside the non-martial's level (single-source; the composition the user warned about).
  const mixed   = await mk("__PW__DodgeMixed",   { skills: { Athletics: 8 }, arts: [martial("TestAikido", 2, { Dodge: 3 })], dodging: true });
  // MARTIAL-WINS: the dodge art's level+key beats a lower non-martial → the art is chosen, key applies.
  const maWins  = await mk("__PW__DodgeMaWins",  { skills: { Athletics: 4 }, arts: [martial("TestAikido", 5, { Dodge: 3 })], dodging: true });

  const defOf = async (a, dodging) => {
    const d = await MA.rollMeleeDefense(a, { dodging });
    return { skillVal: d.skillVal, dodgeKeyBonus: d.dodgeKeyBonus, total: d.total, ref: d.ref };
  };
  // The caller's additive rule: declared-dodge bonus = 2 + the chosen art's Dodge key (0 if none).
  const bonus = (d) => 2 + (Number(d.dodgeKeyBonus) || 0);

  const dAik = await defOf(aikido, true);
  const dAikNo = await defOf(aikido, false);          // NOT dodging → no key leaks into a plain defense
  const dKar = await defOf(karate, true);
  const dNon = await defOf(nonMart, true);
  const dMix = await defOf(mixed, true);
  const dWin = await defOf(maWins, true);

  out.aikidoDodging   = { key: dAik.dodgeKeyBonus, skillVal: dAik.skillVal, bonus: bonus(dAik) };   // key 3, lvl 5, bonus 5
  out.aikidoNotDodge  = { key: dAikNo.dodgeKeyBonus, bonus: bonus({ dodgeKeyBonus: 0 }) };          // key 0 (no dodge declared context)
  out.karateDodging   = { key: dKar.dodgeKeyBonus, bonus: bonus(dKar) };                            // key 0, bonus 2 (= punk)
  out.nonMartDodging  = { key: dNon.dodgeKeyBonus, bonus: bonus(dNon) };                            // key 0, bonus 2
  out.mixedNoCompose  = { key: dMix.dodgeKeyBonus, skillVal: dMix.skillVal };                       // key 0, lvl 8 (Athletics chosen)
  out.martialWins     = { key: dWin.dodgeKeyBonus, skillVal: dWin.skillVal };                       // key 3, lvl 5 (art chosen)

  // ── (B) the caller's additive rule via the pure helper declaredDodgeBonus (no canvas) ──
  // declaredDodgeBonus(isDodging, chosenArtKey): +2 generic stance plus the chosen art's Dodge key.
  out.helper = {
    aikido: MA.declaredDodgeBonus(true, dAik.dodgeKeyBonus),   // 2 + 3 = 5
    karate: MA.declaredDodgeBonus(true, dKar.dodgeKeyBonus),   // 2 + 0 = 2
    nonMart: MA.declaredDodgeBonus(true, dNon.dodgeKeyBonus),  // 2 + 0 = 2
    mixed: MA.declaredDodgeBonus(true, dMix.dodgeKeyBonus),    // 2 + 0 = 2 (Athletics chosen, no key)
    notDodging: MA.declaredDodgeBonus(false, 3),               // 0 (no dodge declared → no bonus at all)
  };

  // ── (C) the OFFERED contest (unit ①): declare posts an offer card; the roll is a chosen click;
  //        the GM's outcome buttons apply/decline; nothing is written at declare time. Buttons are
  //        driven as REAL DOM clicks through the delegated handler (verify-gestures). The old
  //        rollMartialAttack no-damage leg is gone — that export was deleted; the +Dodge fold it
  //        checked is now covered by the offer contest's result-card fold below (resultShowsDodgeFold). ──
  out.offer = { err: null };
  try {
    // The no-damage leg used to arm this gate; set it here now that that leg is gone.
    try { await game.settings.set(SCOPE, "specialMeleeEffectsEnabled", true); } catch {}
    try { ui.sidebar?.expand?.(); ui.sidebar?.activateTab?.("chat"); } catch {}
    const attacker2 = await mk("__PW__DodgeOfferAtk", { skills: { Brawling: 6 } });

    // SkillDodgeEscape candidate: the base's canonical skill now counts in the selection.
    const dnE = await mk("__PW__DodgeEscapeOnly", { skills: { "Dodge & Escape": 7 } });
    const dDE = await MA.rollMeleeDefense(dnE, { dodging: false });
    out.offer.dodgeEscape = { skillName: dDE.skillName, skillVal: dDE.skillVal };  // "Dodge & Escape", 7

    // Gate + shape: an offer posts for a contested maneuver, never for the self-action; off-gate = no card.
    const flagOf = () => aikido.getFlag(SCOPE, "grappledBy") ?? null;
    const btnFor = async (cls) => {
      await sleep(600); ui.chat?.render?.(true); await sleep(400);
      return [...document.querySelectorAll(`${cls}[data-target-actor-id="${aikido.id}"]`)].pop() ?? null;
    };
    const offered = await MA.postMartialDefenseOffer({ attackerActor: attacker2, targetActor: aikido, action: "Grapple" });
    out.offer.posts = offered === true;
    out.offer.noWriteAtDeclare = flagOf() === null;
    out.offer.escapeNotOffered = (await MA.postMartialDefenseOffer({ attackerActor: attacker2, targetActor: aikido, action: "Escape" })) === false;
    const gateWas = game.settings.get(SCOPE, "specialMeleeEffectsEnabled");
    await game.settings.set(SCOPE, "specialMeleeEffectsEnabled", false);
    out.offer.gateOff = (await MA.postMartialDefenseOffer({ attackerActor: attacker2, targetActor: aikido, action: "Grapple" })) === false;
    await game.settings.set(SCOPE, "specialMeleeEffectsEnabled", gateWas);

    // The chosen roll: a real click on the offer's roll button → the result card (breakdown + outcome
    // buttons + the opposed roll attached). The dodging Aikido defender's clause shows the +5 fold.
    const rollBtn = await btnFor(".cp-martial-defense-roll");
    out.offer.rollBtnFound = !!rollBtn;
    const beforeRoll = game.messages.size;
    rollBtn?.click(); await sleep(800);
    const resultMsg = game.messages.contents.slice(beforeRoll).find(m => (m.content || "").includes("cp-martial-defense-lands"));
    out.offer.resultPosts = !!resultMsg;
    out.offer.resultHasRoll = (resultMsg?.rolls?.length ?? 0) >= 1;
    out.offer.resultShowsDodgeFold = /\+5/.test(resultMsg?.content ?? "");

    // Outcome: [lands] writes the status through the single-home apply path.
    const landsBtn = await btnFor(".cp-martial-defense-lands");
    landsBtn?.click(); await sleep(600);
    out.offer.landsApplies = flagOf() === attacker2.id;
    await aikido.unsetFlag(SCOPE, "grappledBy").catch(() => {});

    // Outcome: [evaded] posts the notice and writes nothing.
    await MA.postMartialDefenseOffer({ attackerActor: attacker2, targetActor: aikido, action: "Grapple" });
    const rollBtn2 = await btnFor(".cp-martial-defense-roll");
    rollBtn2?.click(); await sleep(800);
    const beforeEvade = game.messages.size;
    const evadeBtn = await btnFor(".cp-martial-defense-evaded");
    evadeBtn?.click(); await sleep(600);
    out.offer.evadedNoWrite = flagOf() === null;
    out.offer.evadedNotice = game.messages.contents.slice(beforeEvade).some(m => /evades/i.test(m.content || ""));

    // Outcome: [apply] skips the contest entirely (the old on-declare, one click away).
    await MA.postMartialDefenseOffer({ attackerActor: attacker2, targetActor: aikido, action: "Grapple" });
    const applyBtn = await btnFor(".cp-martial-defense-apply");
    applyBtn?.click(); await sleep(600);
    out.offer.applySkipsContest = flagOf() === attacker2.id;
    await aikido.unsetFlag(SCOPE, "grappledBy").catch(() => {});

    await attacker2.delete().catch(() => {});
    await dnE.delete().catch(() => {});
  } catch (e) { out.offer.err = e?.message || String(e); }

  for (const a of [aikido, karate, nonMart, mixed, maWins]) await a.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["Aikido dodger: Dodge key 3, art level 5 → declared-dodge bonus 5 (2+3)", r.aikidoDodging.key === 3 && r.aikidoDodging.skillVal === 5 && r.aikidoDodging.bonus === 5],
  ["Aikido NOT dodging: no Dodge key leaks into a plain defense (key 0)", r.aikidoNotDodge.key === 0],
  ["Karate dodger (no Dodge key): bonus 2 (= generic stance, not worse than a punk)", r.karateDodging.key === 0 && r.karateDodging.bonus === 2],
  ["non-martial dodger: bonus 2 (generic stance only)", r.nonMartDodging.key === 0 && r.nonMartDodging.bonus === 2],
  ["ANTI-COMPOSE: higher non-martial (Athletics 8) chosen over low art → key 0, level 8", r.mixedNoCompose.key === 0 && r.mixedNoCompose.skillVal === 8],
  ["art chosen when its level+key wins (Athletics 4 vs Aikido 5+3) → key 3, level 5", r.martialWins.key === 3 && r.martialWins.skillVal === 5],
  ["caller rule: Aikido dodger → +5 (2 stance + 3 key)", r.helper.aikido === 5],
  ["caller rule: Karate / non-martial / mixed dodger → +2 (stance only)", r.helper.karate === 2 && r.helper.nonMart === 2 && r.helper.mixed === 2],
  ["caller rule: not dodging → +0 (no bonus at all)", r.helper.notDodging === 0],
  ["canonical Dodge & Escape skill counts in the selection (stable key + level 7)", r.offer.dodgeEscape?.skillName === "DodgeEscape" && r.offer.dodgeEscape?.skillVal === 7],
  ["offer: declare posts the card, writes NO state; self-action + off-gate post nothing", r.offer.posts === true && r.offer.noWriteAtDeclare === true && r.offer.escapeNotOffered === true && r.offer.gateOff === true],
  ["offer: the chosen roll posts the result card with the opposed roll + the +5 fold", r.offer.rollBtnFound === true && r.offer.resultPosts === true && r.offer.resultHasRoll === true && r.offer.resultShowsDodgeFold === true],
  ["outcome: [lands] applies the status via the single-home path", r.offer.landsApplies === true],
  ["outcome: [evaded] posts the notice and writes nothing", r.offer.evadedNoWrite === true && r.offer.evadedNotice === true],
  ["outcome: [apply] skips the contest (one-click old behavior)", r.offer.applySkipsContest === true],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
