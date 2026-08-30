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
    // ⏪ the module's special-melee gate retired 2026-08-29 (settings-trim): declaring the action is
    //    the consent, so there is nothing to arm here.
    try { ui.sidebar?.expand?.(); ui.sidebar?.activateTab?.("chat"); } catch {}
    const attacker2 = await mk("__PW__DodgeOfferAtk", { skills: { Brawling: 6 } });

    // SkillDodgeEscape candidate: the base's canonical skill now counts in the selection.
    const dnE = await mk("__PW__DodgeEscapeOnly", { skills: { "Dodge & Escape": 7 } });
    const dDE = await MA.rollMeleeDefense(dnE, { dodging: false });
    out.offer.dodgeEscape = { skillName: dDE.skillName, skillVal: dDE.skillVal };  // "Dodge & Escape", 7

    // Shape: an offer posts for a contested maneuver, never for the self-action.
    const flagOf = () => aikido.getFlag(SCOPE, "grappledBy") ?? null;
    const btnFor = async (cls) => {
      await sleep(600); ui.chat?.render?.(true); await sleep(400);
      return [...document.querySelectorAll(`${cls}[data-target-actor-id="${aikido.id}"]`)].pop() ?? null;
    };
    const offered = await MA.postMartialDefenseOffer({ attackerActor: attacker2, targetActor: aikido, action: "Grapple" });
    out.offer.posts = offered === true;
    out.offer.noWriteAtDeclare = flagOf() === null;
    out.offer.escapeNotOffered = (await MA.postMartialDefenseOffer({ attackerActor: attacker2, targetActor: aikido, action: "Escape" })) === false;
    // ⏪ off-state leg retired 2026-08-29 with its switch (settings-trim) - "gate off means no offer
    //    card" went with the module's special-melee key.

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

  // ── (D) the tracker stance flags reaching the ATTACKER's Modifiers window ──────────────────────
  // The declared-stance flags used to be written and then read by (almost) nothing: `dodging` only by
  // the offered grapple contest above, `parrying` by nothing at all. The prefill hook in
  // combat/damage-hooks.js is where they now meet an ordinary attack. Everything here drives the REAL
  // opener (the sheet's _cpOpenAttackModifiers, which builds the target list from the user's targets)
  // and reads the rendered window, not the hook's internals.
  out.prefill = { err: null };
  out.stance  = { err: null };
  const restoreSettings = {};
  let prevActiveSceneId = null;
  const madeFixtures = [];
  try {
    // ⏪ the declared-defence switch and the two multi-action keys retired 2026-08-29 (settings-trim):
    //    all three behaviours are unconditional now, so nothing is snapshot or armed. The multi-action
    //    fold writes the SAME field as the stance prefill, but its penalty is zero outside a started
    //    combat - and this section runs before section (E) starts one - so every number read below is
    //    still attributable to the stance hook alone.

    prevActiveSceneId = game.scenes.active?.id ?? null;
    for (const s of [...game.scenes]) if (s.name?.startsWith("__PW__Dodge")) await s.delete().catch(() => {});
    const [scene] = await Scene.create([{
      name: "__PW__DodgeDialogScene", width: 2000, height: 2000, padding: 0,
      grid: { size: 100, type: CONST.GRID_TYPES.SQUARE },
    }]);
    await scene.activate();
    for (let i = 0; i < 150 && !(canvas?.ready && canvas.scene?.id === scene.id); i++) await sleep(200);
    const G = scene.grid?.size ?? 100;

    const attacker = await mk("__PW__DodgeSwinger", { skills: { Brawling: 6 } });
    const defA = await mk("__PW__DodgeTargetA", { skills: { Athletics: 5 } });
    const defB = await mk("__PW__DodgeTargetB", { skills: { Athletics: 5 } });
    const defC = await mk("__PW__DodgeTargetC", { skills: { Athletics: 5 } });
    madeFixtures.push(attacker, defA, defB, defC);

    // isRanged() is decided by weaponType/attackType (base item.js): "Melee" on either takes the melee
    // road, a Pistol the ranged one. Both live on ONE attacker so the two dialogs differ in nothing
    // except the flow under test.
    const [knife] = await attacker.createEmbeddedDocuments("Item", [{
      name: "__PW__DodgeKnife", type: "weapon",
      system: { equipped: true, weaponType: "Melee", attackType: "Melee", damage: "1d6", accuracy: 0 } }]);
    const [pistol] = await attacker.createEmbeddedDocuments("Item", [{
      name: "__PW__DodgePistol", type: "weapon",
      system: { equipped: true, weaponType: "Pistol", attackType: "P", damage: "2d6+1", rof: 2, range: 50, shots: 10, shotsLeft: 10, accuracy: 0 } }]);

    const [tokA] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__DodgeTokA", actorId: defA.id, actorLink: true,  x: 4 * G, y: 2 * G, width: 1, height: 1 }]);
    const [tokB] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__DodgeTokB", actorId: defB.id, actorLink: true,  x: 6 * G, y: 2 * G, width: 1, height: 1 }]);
    // Fixture diversity: a linked figure and an UNLINKED second figure of the SAME actor. An unlinked
    // token keeps its own flags, so the pair is what proves the read is token-scoped rather than
    // "whatever actor shares this id" (the documented id-collision class).
    const [tokC1] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__DodgeTokC1", actorId: defC.id, actorLink: true,  x: 8 * G, y: 2 * G, width: 1, height: 1 }]);
    const [tokC2] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__DodgeTokC2", actorId: defC.id, actorLink: false, x: 10 * G, y: 2 * G, width: 1, height: 1 }]);
    await sleep(500);

    const sheet = attacker.sheet;
    out.prefill.openerPresent = typeof sheet?._cpOpenAttackModifiers === "function";

    /** Target the given tokens, open the weapon's real attack window, and report what the rendered
     *  window says: whether the Extra Modifiers row exists at all, its value, and the note lines. */
    const openAndRead = async (item, tokenIds) => {
      const res = { found: false, val: null, noteCount: 0, notes: [], err: null };
      let dlg = null;
      try {
        for (const t of [...(game.user?.targets ?? [])]) t.setTarget(false, { releaseOthers: false, groupSelection: true });
        await sleep(120);
        for (const id of tokenIds) canvas.tokens.get(id)?.setTarget(true, { releaseOthers: false, groupSelection: true });
        await sleep(200);
        dlg = sheet._cpOpenAttackModifiers(item);
        await sleep(800);   // render + the note block's own template fetch
        const root = dlg?.element ?? null;
        const inp = root?.querySelector?.("input[name='extraMod']") ?? null;
        res.found = !!inp;
        res.val = inp ? String(inp.value ?? "") : null;
        const noteEls = root?.querySelectorAll?.(".cp-declared-defense .cp-declared-defense-note") ?? [];
        res.notes = [...noteEls].map(n => (n.textContent || "").trim());
        res.noteCount = res.notes.length;
      } catch (e) { res.err = String(e?.message ?? e); }
      try { await dlg?.close?.({ animate: false }); } catch (_e) { /* already gone */ }
      await sleep(200);
      return res;
    };
    // D1 — MELEE vs a declared dodge: the book's −2 lands in the field, with a line naming who and why.
    await defA.setFlag(SCOPE, "dodging", true); await sleep(150);
    out.prefill.meleeVsDodger = await openAndRead(knife, [tokA.id]);
    // D2 — RANGED vs the SAME flagged target: nothing at all. Core prints no rule for dodging fire, so
    // this is the book NEGATIVE, not an oversight — it is asserted as hard as the positive.
    out.prefill.rangedVsDodger = await openAndRead(pistol, [tokA.id]);
    // D8 (second-act rule) — reopening the same window re-reads the flag ONCE; −2 must not become −4.
    out.prefill.meleeVsDodgerReopen = await openAndRead(knife, [tokA.id]);

    // D3 — PARRY is a REMINDER: a note, and deliberately NO number (the outcome is an opposed roll).
    await defB.setFlag(SCOPE, "parrying", true); await sleep(150);
    out.prefill.meleeVsParry = await openAndRead(knife, [tokB.id]);

    // D5 — two targets selected: `extraMod` is a single number on the attacker's roll, so it carries
    // no per-target penalty. Both stances are NAMED and none is folded.
    out.prefill.meleeMultiTarget = await openAndRead(knife, [tokA.id, tokB.id]);

    // D6 — token scope: the stance is declared on the UNLINKED figure only. Its own dialog gets the
    // fold; the linked twin (same base actor, clean flags) gets nothing.
    await canvas.tokens.get(tokC2.id)?.actor?.setFlag(SCOPE, "dodging", true); await sleep(200);
    out.prefill.unlinkedFigure = await openAndRead(knife, [tokC2.id]);
    out.prefill.linkedTwin     = await openAndRead(knife, [tokC1.id]);
    await canvas.tokens.get(tokC2.id)?.actor?.unsetFlag(SCOPE, "dodging").catch(() => {});

    // D4 — flag cleared: back to nothing, on the same fixtures that just proved the positive.
    await defA.unsetFlag(SCOPE, "dodging").catch(() => {});
    await defB.unsetFlag(SCOPE, "parrying").catch(() => {});
    await sleep(200);
    out.prefill.flagsCleared = await openAndRead(knife, [tokA.id, tokB.id]);

    // ⏪ D7 off-state leg retired 2026-08-29 with its switch (settings-trim) - "the flag may be set,
    //    the window stays untouched" was the declared-defence key's off reading.

    // The shipped constant itself, so the legs above are checked against the module's number rather
    // than a re-typed copy of it.
    const DH = await import("/modules/cp2020-augmented/module/combat/damage-hooks.js");
    out.prefill.constant = DH.DECLARED_DODGE_ATTACK_MOD;

    // ── (E) the tracker controls still toggle, and still count the action ──────────────────────────
    // The −3-to-other-actions half of the p.112 clause is represented by the declaration COSTING an
    // action, not by a second penalty — so this section is the proof that the counter still moves.
    try {
      for (const c of [...game.combats]) if (c.combatants.some(cb => cb.name?.startsWith?.("__PW__Dodge"))) await c.delete().catch(() => {});
      const combat = await Combat.create({});
      await combat.createEmbeddedDocuments("Combatant", [{ actorId: attacker.id, name: "__PW__DodgeSwinger" }]);
      await combat.activate(); await combat.startCombat(); await sleep(500);
      try { ui.sidebar?.expand?.(); ui.sidebar?.activateTab?.("combat"); } catch (_e) { /* headless sidebar */ }
      ui.combat?.render(true); await sleep(800);

      const btn = (cls) => document.querySelector(`${cls}[data-actor-id="${attacker.id}"]`);
      const count = () => Number(attacker.getFlag(SCOPE, "actionCount") ?? 0);

      out.stance.dodgeBtnRendered = !!btn(".cp-dodge-btn");
      out.stance.parryBtnRendered = !!btn(".cp-parry-btn");
      // Wiring leg: the field the handler reads must be non-empty on the rendered node.
      out.stance.dodgeBtnActorId = btn(".cp-dodge-btn")?.dataset?.actorId || "";

      const c0 = count();
      btn(".cp-dodge-btn")?.click();
      for (let i = 0; i < 40 && !attacker.getFlag(SCOPE, "dodging"); i++) await sleep(120);
      await sleep(300);
      out.stance.dodgeSetsFlag = attacker.getFlag(SCOPE, "dodging") === true;
      out.stance.dodgeCountsAction = count() === c0 + 1;

      ui.combat?.render(true); await sleep(600);
      const c1 = count();
      btn(".cp-parry-btn")?.click();
      for (let i = 0; i < 40 && !attacker.getFlag(SCOPE, "parrying"); i++) await sleep(120);
      await sleep(300);
      out.stance.parrySetsFlag = attacker.getFlag(SCOPE, "parrying") === true;
      out.stance.parryCountsAction = count() === c1 + 1;

      // Second act: the same gesture again is the CANCEL, and a cancel is not a new action.
      ui.combat?.render(true); await sleep(600);
      const c2 = count();
      btn(".cp-dodge-btn")?.click();
      for (let i = 0; i < 40 && attacker.getFlag(SCOPE, "dodging"); i++) await sleep(120);
      await sleep(300);
      out.stance.dodgeTogglesOff = (attacker.getFlag(SCOPE, "dodging") ?? false) === false;
      out.stance.cancelCostsNothing = count() === c2;

      await combat.delete().catch(() => {});
    } catch (e) { out.stance.err = String(e?.message ?? e); }

    for (const t of [...(game.user?.targets ?? [])]) t.setTarget(false, { releaseOthers: false, groupSelection: true });
    await scene.delete().catch(() => {});
  } catch (e) { out.prefill.err = String(e?.message ?? e); }
  finally {
    for (const a of madeFixtures) await a.delete().catch(() => {});
    for (const s of [...game.scenes]) if (s.name?.startsWith("__PW__Dodge")) await s.delete().catch(() => {});
    if (prevActiveSceneId) await game.scenes.get(prevActiveSceneId)?.activate().catch(() => {});
    for (const [k, v] of Object.entries(restoreSettings)) {
      if (v !== undefined) await game.settings.set(SCOPE, k, v).catch(() => {});
    }
  }

  for (const a of [aikido, karate, nonMart, mixed, maWins]) await a.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
// "No fold-in" has to mean the row was FOUND and read as zero — a window that never rendered must
// not be able to pass a negative leg by returning nothing (the vacuous-leg rule).
const noFold = (x) => !!x && x.found === true && !x.err && (x.val === "" || x.val === "0");
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
  // ⏪ the off-gate clause of this leg retired 2026-08-29 with its switch (settings-trim).
  ["offer: declare posts the card, writes NO state; the self-action posts nothing", r.offer.posts === true && r.offer.noWriteAtDeclare === true && r.offer.escapeNotOffered === true],
  ["offer: the chosen roll posts the result card with the opposed roll + the +5 fold", r.offer.rollBtnFound === true && r.offer.resultPosts === true && r.offer.resultHasRoll === true && r.offer.resultShowsDodgeFold === true],
  ["outcome: [lands] applies the status via the single-home path", r.offer.landsApplies === true],
  ["outcome: [evaded] posts the notice and writes nothing", r.offer.evadedNoWrite === true && r.offer.evadedNotice === true],
  ["outcome: [apply] skips the contest (one-click old behavior)", r.offer.applySkipsContest === true],
  // ⏪ GATED 2026-08-16 (vacuous-leg audit): the whole offer section sits in one try/catch whose throw
  // went into `offer.err`, read by nothing. Named so a stopped section is legible in the log.
  ["offer section ran to the end (did not stop on a throw)", !r.offer.err, r.offer.err],

  // ── (D) declared-stance flag → the attacker's Modifiers window ──
  ["opener present: the sheet exposes the real attack-window builder", r.prefill.openerPresent === true],
  ["shipped constant is −2", r.prefill.constant === -2],
  ["MELEE flow, target flagged: Extra Modifiers row reads -2 and one note line is rendered",
    r.prefill.meleeVsDodger?.found === true && r.prefill.meleeVsDodger?.val === "-2" && r.prefill.meleeVsDodger?.noteCount === 1],
  ["that note names the flagged target (the GM can see WHY the field moved)",
    /__PW__DodgeTargetA/.test(r.prefill.meleeVsDodger?.notes?.[0] ?? "")],
  ["NEGATIVE — RANGED flow, same flagged target: field unchanged and NO note block",
    noFold(r.prefill.rangedVsDodger) && r.prefill.rangedVsDodger?.noteCount === 0],
  ["second act — reopening the melee window folds once, not twice (still -2)",
    r.prefill.meleeVsDodgerReopen?.val === "-2" && r.prefill.meleeVsDodgerReopen?.noteCount === 1],
  ["parry flag: a note is rendered and the field is deliberately NOT moved",
    noFold(r.prefill.meleeVsParry) && r.prefill.meleeVsParry?.noteCount === 1 && /__PW__DodgeTargetB/.test(r.prefill.meleeVsParry?.notes?.[0] ?? "")],
  ["two targets selected: both stances named, no number folded (one field cannot carry a per-target term)",
    noFold(r.prefill.meleeMultiTarget) && r.prefill.meleeMultiTarget?.noteCount === 2],
  ["token-scoped read: the UNLINKED figure's own flag folds -2 for its dialog",
    r.prefill.unlinkedFigure?.val === "-2" && r.prefill.unlinkedFigure?.noteCount === 1],
  ["token-scoped read: the LINKED twin of the same base actor gets nothing",
    noFold(r.prefill.linkedTwin) && r.prefill.linkedTwin?.noteCount === 0],
  ["flags cleared: same fixtures, same targets → field unchanged and no note block",
    noFold(r.prefill.flagsCleared) && r.prefill.flagsCleared?.noteCount === 0],
  // ⏪ off-state leg retired 2026-08-29 with its switch (settings-trim): "feature gate OFF: flag set,
  //    window untouched" had nothing left to switch off.
  ["prefill section ran to the end (did not stop on a throw)", !r.prefill.err, r.prefill.err],

  // ── (E) the tracker controls still toggle and still cost an action ──
  ["tracker controls render for the active combatant, carrying a non-empty actor id",
    r.stance.dodgeBtnRendered === true && r.stance.parryBtnRendered === true && (r.stance.dodgeBtnActorId ?? "") !== ""],
  ["dodge control: real click writes the flag AND advances the shared action counter by 1",
    r.stance.dodgeSetsFlag === true && r.stance.dodgeCountsAction === true],
  ["parry control: real click writes the flag AND advances the counter by 1",
    r.stance.parrySetsFlag === true && r.stance.parryCountsAction === true],
  ["second act — the same control again clears the flag and costs nothing",
    r.stance.dodgeTogglesOff === true && r.stance.cancelCostsNothing === true],
  ["stance section ran to the end (did not stop on a throw)", !r.stance.err, r.stance.err],

  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
