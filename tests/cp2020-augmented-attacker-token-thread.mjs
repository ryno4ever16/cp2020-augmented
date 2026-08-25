/**
 * ATTACKER-SIDE DOCUMENT RESOLUTION ON THE FIRE PATH. :30004 (official 1.1.1 + module).
 *
 * The `cyberpunk2020.weaponFired` listeners that touch the ATTACKER resolved it with
 * `game.actors.get(payload.attackerId)`. An unlinked token's synthetic actor SHARES its id with its
 * world actor (the documented id-collision class), so every one of those reads and writes landed on
 * the base actor instead of on the figure that pulled the trigger:
 *
 *   · the aim was spent off the base while the figure's own aim stood forever,
 *   · the per-round action counter accrued on the base, which every unlinked copy inherits and reads
 *     back as its own (a sibling's window folded a penalty it never earned),
 *   · a mono blade broke on the base — i.e. on every copy of it, and not on the one that swung,
 *   · the impaired-arm notice reported the base's arms rather than the shooter's,
 *   · and the three AREA CARDS (gas cloud, blast, pattern) were headed with the base actor's name and
 *     pointed at whichever figure of that base the canvas listed first — Foundry's own getSpeaker takes
 *     `getActiveTokens()[0]` for a world actor — rather than at the figure that fired (§8).
 *
 * The fix threads the figure through: the seam already captures it at the trigger pull and carries it
 * as `payload.attackerTokenId` (seam-shim.js `firingTokenIdOf`), and utils.js `firingActorOf` turns
 * that into the document, falling back to the combatant when the answer is unique and to today's id
 * lookup when nothing can name a figure. Every fallback rung is pinned below by value.
 *
 * Companion suite: cp2020-augmented-tracker-flag-scope.mjs (the same defect class on the four
 * combat-tracker controls). Linked behaviour must be byte-identical in both.
 *
 *   FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node tests/cp2020-augmented-attacker-token-thread.mjs
 */
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
await p.waitForTimeout(2000);

const r = await p.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const out = {
    err: null, scope: {}, resolver: {}, aim: {}, action: {}, mono: {}, arm: {},
    realFire: {}, fallback: {}, speaker: {},
  };

  const restore = {};
  let prevSceneId = null;
  const madeActors = [];
  try {
    for (const k of ["aimTrackingEnabled", "multiActionPenaltyEnabled", "multiActionAutoTrack", "combatFxEnabled",
                     "gasGrenadeCloudEnabled", "explosivesEnabled"]) {
      try { restore[k] = game.settings.get(SCOPE, k); } catch { restore[k] = undefined; }
    }
    // The presentation rail is stood down for the whole suite: nothing here measures it, and the
    // apply window waits on its settle signal before it opens (damage-hooks presentationSettled),
    // which would add seconds of dead time to the real-fire section for no assertion.
    await game.settings.set(SCOPE, "combatFxEnabled", false);

    // ── fixtures ───────────────────────────────────────────────────────────────────────────────
    const wipe = async () => {
      for (const c of [...game.combats]) if (c.combatants.some(cb => cb.name?.startsWith?.("__PW__Thread"))) await c.delete().catch(() => {});
      for (const a of game.actors.filter(a => a.name?.startsWith?.("__PW__Thread"))) await a.delete().catch(() => {});
      for (const s of [...game.scenes]) if (s.name?.startsWith?.("__PW__Thread")) await s.delete().catch(() => {});
    };
    await wipe();

    prevSceneId = game.scenes.active?.id ?? null;
    const [scene] = await Scene.create([{
      name: "__PW__ThreadScene", width: 2400, height: 2000, padding: 0,
      grid: { size: 100, type: CONST.GRID_TYPES.SQUARE },
    }]);
    await scene.activate();
    for (let i = 0; i < 150 && !(canvas?.ready && canvas.scene?.id === scene.id); i++) await sleep(200);
    const G = scene.grid?.size ?? 100;

    const mk = async (name) => {
      const a = await Actor.create({ name, type: "character" });
      await a.update({ "system.stats.ref.base": 6, "system.stats.int.base": 6, "system.stats.cool.base": 6 });
      madeActors.push(a);
      return a;
    };

    // ONE base actor with THREE figures of it — two UNLINKED copies and one LINKED. The pair of
    // unlinked copies is what makes a world-directory write visible as a BLEED rather than a
    // harmless extra write; the linked figure is the parity control.
    const base   = await mk("__PW__ThreadBase");
    const lone   = await mk("__PW__ThreadLone");    // exactly ONE figure, for the combatant rung
    const solo   = await mk("__PW__ThreadSolo");    // NO figure, NOT in combat — the bare-fallback control
    const dummy  = await mk("__PW__ThreadDummy");

    const [gun] = await base.createEmbeddedDocuments("Item", [{
      name: "__PW__ThreadGun", type: "weapon",
      system: {
        equipped: true, weaponType: "Pistol", attackType: "Pistol",
        damage: "1d6", accuracy: 0, range: 50, rof: 1, shotsLeft: 40, shots: 40, concealability: "J",
      },
    }]);
    const [blade] = await base.createEmbeddedDocuments("Item", [{
      name: "__PW__ThreadBlade", type: "weapon",
      system: { equipped: true, weaponType: "Melee", attackType: "Melee", damage: "1d6", accuracy: 0, mono: true },
    }]);

    const [tokU1]   = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__ThreadU1", actorId: base.id,  actorLink: false, x: 3 * G, y: 2 * G, width: 1, height: 1 }]);
    const [tokU2]   = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__ThreadU2", actorId: base.id,  actorLink: false, x: 5 * G, y: 2 * G, width: 1, height: 1 }]);
    const [tokL1]   = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__ThreadL1", actorId: base.id,  actorLink: true,  x: 7 * G, y: 2 * G, width: 1, height: 1 }]);
    const [tokLone] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__ThreadLoneTok", actorId: lone.id, actorLink: false, x: 9 * G, y: 2 * G, width: 1, height: 1 }]);
    const [tokDum]  = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__ThreadDummyTok", actorId: dummy.id, actorLink: true, x: 3 * G, y: 6 * G, width: 1, height: 1 }]);
    await sleep(500);

    const u1 = canvas.tokens.get(tokU1.id).actor;
    const u2 = canvas.tokens.get(tokU2.id).actor;
    const l1 = canvas.tokens.get(tokL1.id).actor;
    const lo = canvas.tokens.get(tokLone.id).actor;

    // ── (0) the root cause, and the producer's own answer ──────────────────────────────────────
    out.scope.unlinkedIdLookupDiverges = game.actors.get(u1.id) !== u1;
    out.scope.unlinkedSharesBaseId     = u1.id === base.id;
    out.scope.linkedIdLookupConverges  = game.actors.get(l1.id) === l1 && l1 === base;
    out.scope.siblingsAreDistinctDocs  = u1 !== u2;
    // The SHIPPED capture, not a hand-typed id: the field the consumer reads is the field the seam
    // writes, so the two halves are asserted against each other rather than against a literal.
    const seam = await import(`/modules/${SCOPE}/module/seam-shim.js`);
    out.scope.producerNamesTheFigure = seam.firingTokenIdOf(u1) === tokU1.id
                                    && seam.firingTokenIdOf(u2) === tokU2.id;

    const combat = await Combat.create({});
    await combat.createEmbeddedDocuments("Combatant", [
      { tokenId: tokU1.id,   sceneId: scene.id, actorId: base.id,  name: "__PW__ThreadU1", initiative: 40 },
      { tokenId: tokU2.id,   sceneId: scene.id, actorId: base.id,  name: "__PW__ThreadU2", initiative: 30 },
      { tokenId: tokL1.id,   sceneId: scene.id, actorId: base.id,  name: "__PW__ThreadL1", initiative: 20 },
      { tokenId: tokLone.id, sceneId: scene.id, actorId: lone.id,  name: "__PW__ThreadLone", initiative: 10 },
      { tokenId: tokDum.id,  sceneId: scene.id, actorId: dummy.id, name: "__PW__ThreadDummy", initiative: 5 },
    ]);
    await combat.activate();
    await combat.startCombat();
    await sleep(700);

    // ── readers ────────────────────────────────────────────────────────────────────────────────
    const raw = (doc, key) => doc.getFlag(SCOPE, key) ?? null;
    /** What a TOKEN's own ActorDelta records — the write's LANDING SITE, read off the token document.
     *  A synthetic actor INHERITS its base's flags wherever its delta is silent, so `actor.getFlag`
     *  alone cannot tell a write that landed on the figure from one that landed on the base and was
     *  inherited back. Only a write to this token's own document appears here. */
    const deltaAt = (tokDoc, path) => {
      const src = tokDoc.delta?._source ?? tokDoc.delta?.toObject?.() ?? {};
      const v = foundry.utils.getProperty(src, `flags.${SCOPE}.${path}`);
      return v === undefined ? null : v;
    };
    const clearAll = async () => {
      for (const d of [base, u1, u2, l1, lo, lone, solo]) {
        for (const k of ["aimRounds", "actionCount", "actionCountRound", "fleshLimbStatus", "limbStatus"]) {
          await d.unsetFlag(SCOPE, k).catch(() => {});
        }
      }
      await sleep(300);
    };

    /** Raise the shot the way the seam raises it. `tokenId` null models every producer that cannot
     *  name a figure (a macro, a native emitter older than the field, a keeper driving the roll). */
    const fire = async ({ actorId, tokenId = null, extra = {} }) => {
      const payload = {
        attackerId: actorId,
        weaponName: "__PW__ThreadGun",
        weaponId: gun.id,
        areaDamages: {},
        firedByUserId: game.user.id,
        ...extra,
      };
      if (tokenId) payload.attackerTokenId = tokenId;
      Hooks.callAll("cyberpunk2020.weaponFired", payload);
      await sleep(900);
    };

    // ── (1) the resolver itself, asserted by document IDENTITY ─────────────────────────────────
    const utils = await import(`/modules/${SCOPE}/module/utils.js`);
    const F = utils.firingActorOf;
    out.resolver.exported = typeof F === "function";
    if (out.resolver.exported) {
      out.resolver.namedTokenIsThatFigure   = F({ attackerId: base.id, attackerTokenId: tokU1.id }) === u1
                                           && F({ attackerId: base.id, attackerTokenId: tokU2.id }) === u2;
      out.resolver.linkedTokenIsWorldActor  = F({ attackerId: base.id, attackerTokenId: tokL1.id }) === base;
      out.resolver.unknownTokenFallsBack    = F({ attackerId: base.id, attackerTokenId: "notatokenid00000" }) === base;
      // THREE combatants share this actor id — a genuine ambiguity, which is NOT guessed at.
      out.resolver.ambiguousCombatFallsBack = F({ attackerId: base.id }) === base;
      // ONE combatant carries this actor id, so the figure is unique and IS resolved.
      out.resolver.uniqueCombatantResolves  = F({ attackerId: lone.id }) === lo;
      out.resolver.uniqueCombatantIsNotBase = F({ attackerId: lone.id }) !== lone;
      out.resolver.notInCombatFallsBack     = F({ attackerId: solo.id }) === solo;
      out.resolver.emptyPayloadIsNull       = F({}) === null && F(null) === null;
      out.resolver.legacyActorIdAliasWorks  = F({ actorId: solo.id }) === solo;
    }

    // ── (2) the aim is spent by the figure that fired ──────────────────────────────────────────
    await game.settings.set(SCOPE, "aimTrackingEnabled", true);
    await game.settings.set(SCOPE, "multiActionPenaltyEnabled", false);   // isolate the flag under test
    await game.settings.set(SCOPE, "multiActionAutoTrack", false);
    await clearAll();
    // A stray aim STANDING ON THE BASE, on purpose: it is what an id lookup finds and clears, so its
    // survival is the two-sided proof that the clear went somewhere else.
    await base.setFlag(SCOPE, "aimRounds", 2);
    await u1.setFlag(SCOPE, "aimRounds", 1);
    await sleep(300);
    await fire({ actorId: base.id, tokenId: tokU1.id });
    out.aim.figureSpent    = deltaAt(tokU1, "aimRounds");   // expected null — the figure's aim is gone
    out.aim.baseUntouched  = raw(base, "aimRounds");        // expected 2    — the base is not a party
    out.aim.siblingClean   = deltaAt(tokU2, "aimRounds");   // expected null — never written either way

    // second act, on the OTHER figure: two copies of one base spend their own aims independently.
    await u2.setFlag(SCOPE, "aimRounds", 3);
    await u1.setFlag(SCOPE, "aimRounds", 1);
    await sleep(300);
    await fire({ actorId: base.id, tokenId: tokU2.id });
    out.aim.secondFigureSpent   = deltaAt(tokU2, "aimRounds");  // expected null
    out.aim.firstFigureStands   = deltaAt(tokU1, "aimRounds");  // expected 1 — the other copy is untouched
    out.aim.baseStillUntouched  = raw(base, "aimRounds");       // expected 2
    await clearAll();

    // ── (3) the action counter belongs to the figure that acted ────────────────────────────────
    await game.settings.set(SCOPE, "multiActionPenaltyEnabled", true);
    await game.settings.set(SCOPE, "multiActionAutoTrack", true);
    await clearAll();
    await fire({ actorId: base.id, tokenId: tokU1.id });
    await fire({ actorId: base.id, tokenId: tokU1.id });
    out.action.figureCount   = deltaAt(tokU1, "actionCount");   // expected 2
    out.action.baseCount     = raw(base, "actionCount");        // expected null
    out.action.siblingCount  = deltaAt(tokU2, "actionCount");   // expected null
    await fire({ actorId: base.id, tokenId: tokU2.id });
    out.action.siblingAfterOwnShot = deltaAt(tokU2, "actionCount");  // expected 1
    out.action.figureStillTwo      = deltaAt(tokU1, "actionCount");  // expected 2
    out.action.baseStillNull       = raw(base, "actionCount");       // expected null

    // THE OUTCOME A READER SEES: the attack window's own pre-filled penalty, read off each figure's
    // real dialog. Two actions taken means the third is declared at -6; one action means -3. A count
    // pooled on the base would quote the SAME number to both figures.
    const readPrefill = async (actor) => {
      const res = { found: false, val: null, err: null };
      let dlg = null;
      try {
        for (const t of [...(game.user?.targets ?? [])]) t.setTarget(false, { releaseOthers: false, groupSelection: true });
        await sleep(150);
        dlg = actor.sheet._cpOpenAttackModifiers(actor.items.get(gun.id));
        await sleep(900);
        const inp = dlg?.element?.querySelector?.("input[name='extraMod']") ?? null;
        res.found = !!inp;
        res.val = inp ? String(inp.value ?? "") : null;
      } catch (e) { res.err = String(e?.message ?? e); }
      try { await dlg?.close?.({ animate: false }); } catch (_e) { /* already gone */ }
      await sleep(250);
      return res;
    };
    out.action.prefillTwoActions = await readPrefill(u1);   // expected "-6"
    out.action.prefillOneAction  = await readPrefill(u2);   // expected "-3"
    await clearAll();

    // ── (4) a mono blade breaks on the figure that swung ───────────────────────────────────────
    await base.items.get(blade.id).update({ "system.broken": false }).catch(() => {});
    await sleep(250);
    await fire({
      actorId: base.id, tokenId: tokU1.id,
      extra: { weaponId: blade.id, weaponName: "__PW__ThreadBlade", mono: true, fumble: true },
    });
    await sleep(700);
    out.mono.figureBroken = u1.items.get(blade.id)?.system?.broken ?? null;   // expected true
    out.mono.baseIntact   = base.items.get(blade.id)?.system?.broken ?? null; // expected false — the directory copy is not the one that swung
    out.mono.siblingIntact = u2.items.get(blade.id)?.system?.broken ?? null;  // expected false
    // The landing site itself, off the token's own document.
    const itemDelta = (tokDoc, itemId) => {
      const src = tokDoc.delta?._source ?? tokDoc.delta?.toObject?.() ?? {};
      const it = (src.items ?? []).find(i => (i._id ?? i.id) === itemId);
      return it ? (foundry.utils.getProperty(it, "system.broken") ?? null) : null;
    };
    out.mono.figureDelta  = itemDelta(tokU1, blade.id);   // expected true
    out.mono.siblingDelta = itemDelta(tokU2, blade.id);   // expected null
    await base.items.get(blade.id).update({ "system.broken": false }).catch(() => {});

    // ── (5) the impaired-arm notice reports the SHOOTER's arms ─────────────────────────────────
    const noticeTitle = game.i18n.localize("CYBERPUNK.CyberlimbArmNoticeTitle");
    await u1.setFlag(SCOPE, "fleshLimbStatus", { rArm: "severed" });
    await sleep(400);
    const countNotices = async (fn) => {
      const before = new Set(game.messages.map(m => m.id));
      await fn();
      await sleep(1200);
      return game.messages.filter(m => !before.has(m.id) && String(m.content ?? "").includes(noticeTitle)).length;
    };
    out.arm.noticeForWreckedFigure = await countNotices(() => fire({ actorId: base.id, tokenId: tokU1.id }));  // expected 1
    out.arm.noticeTitleResolved    = !!noticeTitle && noticeTitle !== "CYBERPUNK.CyberlimbArmNoticeTitle";
    out.arm.noticeForCleanFigure   = await countNotices(() => fire({ actorId: base.id, tokenId: tokU2.id }));  // expected 0
    await u1.unsetFlag(SCOPE, "fleshLimbStatus").catch(() => {});
    await clearAll();

    // ── (6) A REAL SHOT, driven through the sheet's own fire control ───────────────────────────
    // Everything above raises the hook directly. This section pulls the trigger the way a player
    // does — the fire button, the modifiers window, its submit — so the seam's capture and the
    // listeners' resolution are exercised as one chain.
    await clearAll();
    await base.setFlag(SCOPE, "aimRounds", 2);   // the stray on the directory entry again
    await u1.setFlag(SCOPE, "aimRounds", 1);
    await sleep(300);
    const seen = [];
    const tapId = Hooks.on("cyberpunk2020.weaponFired", (pl) => seen.push({
      attackerId: pl.attackerId ?? null, attackerTokenId: pl.attackerTokenId ?? null,
    }));
    try {
      for (const a of [...foundry.applications.instances.values()]) {
        if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (_e) { /* closed */ } }
      }
      canvas.tokens.get(tokDum.id)?.setTarget(true, { releaseOthers: true });
      canvas.tokens.get(tokU1.id)?.control({ releaseOthers: true });
      await sleep(300);
      const sheet = u1.sheet;
      await sheet.render(true);
      await sleep(1600);
      const el = sheet.element.querySelector(`.fire-weapon[data-item-id="${gun.id}"]`)
              ?? sheet.element.querySelector(`[data-item-id="${gun.id}"] .fire-weapon`);
      out.realFire.controlFound = !!el;
      if (el) {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        let dlg = null;
        for (let i = 0; i < 60 && !dlg; i++) {
          await sleep(300);
          dlg = [...foundry.applications.instances.values()]
            .find(a => /ModifiersDialog/.test(a?.constructor?.name ?? "") && a.rendered === true) ?? null;
        }
        out.realFire.windowOpened = !!dlg;
        if (dlg) {
          const btn = dlg.element.querySelector('button[type="submit"], footer button');
          if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          else dlg.element.requestSubmit?.();
          for (let i = 0; i < 60 && seen.length === 0; i++) await sleep(300);
          await sleep(1500);
        }
      }
    } catch (e) { out.realFire.err = String(e?.message ?? e); }
    Hooks.off("cyberpunk2020.weaponFired", tapId);
    out.realFire.payloadRaised   = seen.length;
    out.realFire.namedTheFigure  = seen[0]?.attackerTokenId ?? null;   // expected tokU1.id
    out.realFire.expectedTokenId = tokU1.id;
    out.realFire.figureCounted   = deltaAt(tokU1, "actionCount");      // expected 1
    out.realFire.baseNotCounted  = raw(base, "actionCount");           // expected null
    out.realFire.figureAimSpent  = deltaAt(tokU1, "aimRounds");        // expected null
    out.realFire.baseAimStands   = raw(base, "aimRounds");             // expected 2
    for (const a of [...foundry.applications.instances.values()]) {
      if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (_e) { /* closed */ } }
    }
    for (const t of [...(game.user?.targets ?? [])]) t.setTarget(false, { releaseOthers: false, groupSelection: true });
    canvas.tokens.releaseAll();
    await clearAll();

    // ── (7) THE FALLBACK LADDER, pinned exactly ────────────────────────────────────────────────
    // (a) ambiguity — three figures of one base, no named token: today's answer, unchanged.
    await base.setFlag(SCOPE, "aimRounds", 2);
    await sleep(250);
    await fire({ actorId: base.id });                     // no attackerTokenId at all
    out.fallback.ambiguousClearsBase = raw(base, "aimRounds");        // expected null — the id lookup, verbatim
    out.fallback.ambiguousWroteNoDelta = deltaAt(tokU1, "aimRounds") === null && deltaAt(tokU2, "aimRounds") === null;

    // (b) an actor with NO figure and NOT in the fight — the bare id lookup is all there is.
    await solo.setFlag(SCOPE, "aimRounds", 2);
    await sleep(250);
    await fire({ actorId: solo.id });
    out.fallback.soloAimCleared = raw(solo, "aimRounds");             // expected null
    out.fallback.soloNotCounted = raw(solo, "actionCount");           // expected null — out of combat, no counter

    // (c) the combatant rung, end to end: one figure of this base is in the fight, so a payload that
    //     names no token still reaches the FIGURE rather than the directory entry.
    await lone.setFlag(SCOPE, "aimRounds", 2);
    await lo.setFlag(SCOPE, "aimRounds", 1);
    await sleep(300);
    await fire({ actorId: lone.id });
    out.fallback.uniqueFigureSpent = deltaAt(tokLone, "aimRounds");   // expected null
    out.fallback.uniqueBaseStands  = raw(lone, "aimRounds");          // expected 2

    // ── (8) THE THREE AREA CARDS ARE HEADED BY THE FIGURE THAT FIRED ───────────────────────────
    // Gas cloud, blast and pattern each post a card whose SPEAKER was built from the id lookup. For an
    // unlinked copy that is the DIRECTORY ENTRY, so the card was headed with the base's name — and,
    // because Foundry's own getSpeaker takes `getActiveTokens()[0]` for a world actor, it also pointed
    // at whichever figure of that base the canvas listed first rather than at the one that fired.
    // Every leg below reads the SPEAKER OFF THE CREATED MESSAGE, by value.
    await clearAll();
    await game.settings.set(SCOPE, "gasGrenadeCloudEnabled", true);
    await game.settings.set(SCOPE, "explosivesEnabled", true);
    canvas.tokens.releaseAll();
    for (const t of [...(game.user?.targets ?? [])]) t.setTarget(false, { releaseOthers: false, groupSelection: true });
    await sleep(300);

    const hooksMod = await import(`/modules/${SCOPE}/module/combat/damage-hooks.js`);
    // The two REFERENCE answers, taken from the shipped helper rather than hand-typed: `refBase` is
    // what an id lookup produces (and must still be produced wherever no figure can be named),
    // `refSolo` the same for an actor with no figure at all.
    //
    // ⚠ ONLY THE alias AND actor HALVES OF refBase ARE STABLE, and the legs below are written to that.
    // For a WORLD actor Foundry's own getSpeaker takes `getActiveTokens()[0]` (chat-message.mjs CASE 2),
    // an arbitrary pick over the canvas's display order that re-sorts as the layer refreshes — measured
    // here: refBase and refBaseAfter name DIFFERENT figures of the same base within one run, with no
    // module code between them. So "unchanged" is asserted as: the directory entry's NAME, its actor id,
    // and a token that is one of its own figures. Which figure that arbitrary rung lands on is Foundry's
    // to decide and is not what this unit changed.
    const refBase = ChatMessage.getSpeaker({ actor: base });
    const refSolo = ChatMessage.getSpeaker({ actor: solo });
    out.speaker.refBase = refBase;
    out.speaker.refSolo = refSolo;
    out.speaker.baseName            = base.name;
    out.speaker.baseFigureTokens    = [tokU1.id, tokU2.id, tokL1.id];
    out.speaker.expectedFigureToken = tokU2.id;
    out.speaker.expectedFigureAlias = tokU2.name;
    out.speaker.expectedActorId     = base.id;
    out.speaker.soloActorId         = solo.id;
    out.speaker.soloAlias           = solo.name;
    // Is there anything to tell apart in this fixture? Both halves must differ or the legs prove nothing.
    out.speaker.discriminates = refBase.alias !== tokU2.name && refBase.token !== tokU2.id;

    /** The message a placement posted, found by the unique weapon name its own title prints. */
    const cardFor = async (tag, run) => {
      const before = new Set(game.messages.map(m => m.id));
      try { await run(); } catch (e) { return { found: false, err: String(e?.message ?? e) }; }
      for (let i = 0; i < 30; i++) {
        await sleep(200);
        const m = [...game.messages].find(x => !before.has(x.id) && String(x.content ?? "").includes(tag));
        if (m) return { found: true, speaker: JSON.parse(JSON.stringify(m.speaker ?? {})) };
      }
      return { found: false };
    };
    const raise = (payload) => async () => { Hooks.callAll("cyberpunk2020.weaponFired", payload); await sleep(400); };

    // areaDamages is deliberately EMPTY on the gas payloads: the single-target flow stands down without
    // it, so no apply window opens over the cards this section is reading.
    const gasP = (tag, over = {}) => ({
      attackerId: base.id, weaponName: tag, weaponId: gun.id, areaDamages: {},
      effectTypes: ["Gas"], blastRadius: 3, dotTurns: 2, stunSaveMod: -2,
      firedByUserId: game.user.id, ...over,
    });
    const boomP = (tag, over = {}) => ({
      attackerId: base.id, weaponName: tag, weaponId: gun.id,
      areaDamages: { Torso: [{ damage: 10 }] }, effectTypes: ["Explosive"], blastRadius: 3,
      firedByUserId: game.user.id, ...over,
    });
    const spreadP = (tag, over = {}) => ({
      attackerId: base.id, weaponName: tag, weaponId: gun.id,
      areaDamages: { Torso: [{ damage: 7 }] }, shotsFired: 1, shotsHit: 1,
      targetTokenId: tokDum.id, fxTargetTokenId: tokDum.id, firedByUserId: game.user.id,
      caliber: "00", modifier: "standard", spreadMode: "single",
      spreadDamageShort: "", spreadDamageMedium: "", spreadDamageLong: "",
      ...over,
    });

    // (a) the FIGURE case — fired from the SECOND unlinked copy. That both halves of its answer differ
    //     from the directory entry's is not assumed: the `discriminates` leg asserts it for this run.
    out.speaker.gas    = await cardFor("__PWSPK_GAS_FIG",
      raise(gasP("__PWSPK_GAS_FIG", { attackerTokenId: tokU2.id })));
    out.speaker.boom   = await cardFor("__PWSPK_BOOM_FIG",
      raise(boomP("__PWSPK_BOOM_FIG", { attackerTokenId: tokU2.id })));
    out.speaker.spread = await cardFor("__PWSPK_SPREAD_FIG",
      () => hooksMod._placeSpreadZone(spreadP("__PWSPK_SPREAD_FIG", { attackerTokenId: tokU2.id })));

    // (b) the LINKED case — the answer must not move, because a linked figure's own document IS the
    //     world actor, so the resolver hands back exactly what the id lookup handed back.
    out.speaker.gasLinked    = await cardFor("__PWSPK_GAS_LNK",
      raise(gasP("__PWSPK_GAS_LNK", { attackerTokenId: tokL1.id })));
    out.speaker.boomLinked   = await cardFor("__PWSPK_BOOM_LNK",
      raise(boomP("__PWSPK_BOOM_LNK", { attackerTokenId: tokL1.id })));
    out.speaker.spreadLinked = await cardFor("__PWSPK_SPREAD_LNK",
      () => hooksMod._placeSpreadZone(spreadP("__PWSPK_SPREAD_LNK", { attackerTokenId: tokL1.id })));

    // (c) NO FIGURE NAMED, and three copies of the base in the fight — an ambiguity that is not guessed
    //     at, so the card falls to the id lookup and keeps the speaker it has today.
    out.speaker.gasNoToken    = await cardFor("__PWSPK_GAS_AMB",  raise(gasP("__PWSPK_GAS_AMB")));
    out.speaker.boomNoToken   = await cardFor("__PWSPK_BOOM_AMB", raise(boomP("__PWSPK_BOOM_AMB")));
    out.speaker.spreadNoToken = await cardFor("__PWSPK_SPREAD_AMB",
      () => hooksMod._placeSpreadZone(spreadP("__PWSPK_SPREAD_AMB")));

    // (d) an actor with NO figure at all — the bare speaker form (token null). The area needs a point to
    //     form on, which the target token supplies; the pattern has no such rung and is not asked.
    out.speaker.gasSolo  = await cardFor("__PWSPK_GAS_SOLO",
      raise(gasP("__PWSPK_GAS_SOLO", { attackerId: solo.id, targetTokenId: tokDum.id })));
    out.speaker.boomSolo = await cardFor("__PWSPK_BOOM_SOLO",
      raise(boomP("__PWSPK_BOOM_SOLO", { attackerId: solo.id, targetTokenId: tokDum.id })));

    // The same reference, taken again at the end of the section — the receipt for the note above.
    out.speaker.refBaseAfter = ChatMessage.getSpeaker({ actor: base });

    for (const a of [...foundry.applications.instances.values()]) {
      if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (_e) { /* closed */ } }
    }

    await clearAll();
    await combat.delete().catch(() => {});
    await scene.delete().catch(() => {});
  } catch (e) { out.err = String(e?.message ?? e) + " | " + String(e?.stack ?? "").split("\n").slice(0, 3).join(" / "); }
  finally {
    for (const a of madeActors) await a.delete().catch(() => {});
    for (const s of [...game.scenes]) if (s.name?.startsWith?.("__PW__Thread")) await s.delete().catch(() => {});
    for (const c of [...game.combats]) if (c.combatants.some(cb => cb.name?.startsWith?.("__PW__Thread"))) await c.delete().catch(() => {});
    if (prevSceneId) await game.scenes.get(prevSceneId)?.activate().catch(() => {});
    for (const [k, v] of Object.entries(restore)) {
      if (v !== undefined) await game.settings.set(SCOPE, k, v).catch(() => {});
    }
  }
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  // (0) root cause + producer
  ["id lookup diverges from the unlinked figure's own document (and it shares the base id)",
    r.scope.unlinkedIdLookupDiverges === true && r.scope.unlinkedSharesBaseId === true],
  ["id lookup converges for the linked figure (its document IS the world actor)",
    r.scope.linkedIdLookupConverges === true],
  ["the two unlinked figures are distinct documents", r.scope.siblingsAreDistinctDocs === true],
  ["the shipped capture names each figure by its own token id (producer side)",
    r.scope.producerNamesTheFigure === true],

  // (1) the resolver
  ["the shared attacker resolver is exported from utils", r.resolver.exported === true],
  ["named token resolves to THAT figure's own document, per figure",
    r.resolver.namedTokenIsThatFigure === true],
  ["named token on a LINKED figure resolves to the world actor (identity parity)",
    r.resolver.linkedTokenIsWorldActor === true],
  ["a token id this client cannot resolve falls back to the id lookup",
    r.resolver.unknownTokenFallsBack === true],
  ["three combatants of one actor is an ambiguity and is NOT guessed at",
    r.resolver.ambiguousCombatFallsBack === true],
  ["exactly one combatant of an actor resolves to that figure, not the directory entry",
    r.resolver.uniqueCombatantResolves === true && r.resolver.uniqueCombatantIsNotBase === true],
  ["an actor with no figure and no combatant resolves to the world actor",
    r.resolver.notInCombatFallsBack === true],
  ["an empty / absent payload resolves to nothing", r.resolver.emptyPayloadIsNull === true],
  ["the legacy actorId alias is still read", r.resolver.legacyActorIdAliasWorks === true],

  // (2) aim
  ["aim spend lands on the firing figure's own document (delta cleared)",
    r.aim.figureSpent === null],
  ["aim spend does NOT reach into the directory entry (its stray aim still reads 2)",
    r.aim.baseUntouched === 2],
  ["aim spend does NOT reach the sibling figure", r.aim.siblingClean === null],
  ["second act on the other figure: it spends its own aim (delta cleared)",
    r.aim.secondFigureSpent === null],
  ["second act: the first figure's aim still stands at 1 (independent pools)",
    r.aim.firstFigureStands === 1],
  ["second act: the directory entry's stray aim still reads 2", r.aim.baseStillUntouched === 2],

  // (3) action counting
  ["two shots from one figure count 2 on that figure's own document", r.action.figureCount === 2],
  ["the directory entry collects no count", r.action.baseCount === null],
  ["the sibling figure collects no count from another figure's shots", r.action.siblingCount === null],
  ["the sibling's own shot counts 1 on itself", r.action.siblingAfterOwnShot === 1],
  ["the first figure still reads 2 after the sibling fires", r.action.figureStillTwo === 2],
  ["the directory entry still collects no count", r.action.baseStillNull === null],
  ["attack window prefill quotes -6 for the figure that took two actions",
    r.action.prefillTwoActions?.found === true && r.action.prefillTwoActions?.val === "-6",
    JSON.stringify(r.action.prefillTwoActions)],
  ["attack window prefill quotes -3 for the figure that took one (not the pooled number)",
    r.action.prefillOneAction?.found === true && r.action.prefillOneAction?.val === "-3",
    JSON.stringify(r.action.prefillOneAction)],

  // (4) mono break
  ["the fumbled mono blade reads broken on the figure that swung", r.mono.figureBroken === true],
  ["the directory entry's copy of that blade is NOT broken", r.mono.baseIntact === false],
  ["the sibling figure's blade is NOT broken", r.mono.siblingIntact === false],
  ["landing site: the breakage is recorded on that token's OWN delta and on no other's",
    r.mono.figureDelta === true && r.mono.siblingDelta === null],

  // (5) arm notice
  ["the notice title localizes (the counting leg is not matching a raw key)",
    r.arm.noticeTitleResolved === true],
  ["a shot from the figure with the wrecked arm posts exactly one impaired-arm notice",
    r.arm.noticeForWreckedFigure === 1],
  ["a shot from the clean sibling posts none (negative)", r.arm.noticeForCleanFigure === 0],

  // (6) the real shot
  ["the sheet's fire control was found and the attack window opened",
    r.realFire.controlFound === true && r.realFire.windowOpened === true, r.realFire.err],
  ["the real shot raised a payload naming the firing figure by token id",
    r.realFire.payloadRaised > 0 && r.realFire.namedTheFigure === r.realFire.expectedTokenId,
    `raised=${r.realFire.payloadRaised} named=${JSON.stringify(r.realFire.namedTheFigure)}`],
  ["the real shot counted the action on the firing figure (value 1)", r.realFire.figureCounted === 1],
  ["the real shot counted nothing on the directory entry", r.realFire.baseNotCounted === null],
  ["the real shot spent the firing figure's own aim", r.realFire.figureAimSpent === null],
  ["the real shot left the directory entry's stray aim standing at 2", r.realFire.baseAimStands === 2],

  // (7) fallback ladder
  ["no named figure + an ambiguous combat clears the directory entry exactly as before",
    r.fallback.ambiguousClearsBase === null],
  ["...and writes no delta onto any figure while doing it", r.fallback.ambiguousWroteNoDelta === true],
  ["an actor with no figure and no combat clears on the world actor exactly as before",
    r.fallback.soloAimCleared === null],
  ["...and its out-of-combat shot still records no action count", r.fallback.soloNotCounted === null],
  ["combatant rung: a payload naming no token still spends the unique figure's own aim",
    r.fallback.uniqueFigureSpent === null],
  ["combatant rung: that figure's directory entry keeps its stray aim (2)",
    r.fallback.uniqueBaseStands === 2],

  // (8) the three area cards' speakers
  ["the fixture can tell the two answers apart (figure name and token both differ from the base's)",
    r.speaker.discriminates === true,
    `refBase=${JSON.stringify(r.speaker.refBase)} figure=${r.speaker.expectedFigureAlias}/${r.speaker.expectedFigureToken}`],
  // "unchanged" = the DIRECTORY ENTRY's name, its actor id, and one of its own figures. The token half
  // of that answer is Foundry's arbitrary getActiveTokens()[0] pick and is not stable within a run —
  // see the note in §8 and the refBase/refBaseAfter receipt below.
  ...[["gas cloud", "gas"], ["blast", "boom"], ["pattern", "spread"]].flatMap(([label, key]) => {
    const fig = r.speaker[key] ?? {};
    const lnk = r.speaker[key + "Linked"] ?? {};
    const amb = r.speaker[key + "NoToken"] ?? {};
    const asBase = (s) => !!s && s.alias === r.speaker.baseName && s.actor === r.speaker.expectedActorId
                       && (r.speaker.baseFigureTokens ?? []).includes(s.token);
    return [
      [`${label} card posted, and its heading is the FIRING figure's name`,
        fig.found === true && fig.speaker?.alias === r.speaker.expectedFigureAlias,
        JSON.stringify(fig)],
      [`${label} card points at the FIRING figure's own token`,
        fig.speaker?.token === r.speaker.expectedFigureToken, JSON.stringify(fig.speaker)],
      [`${label} card still carries the shared actor id (that half does not move)`,
        fig.speaker?.actor === r.speaker.expectedActorId, JSON.stringify(fig.speaker)],
      [`${label} card from a LINKED figure still reads as the directory entry (unchanged)`,
        lnk.found === true && asBase(lnk.speaker), JSON.stringify(lnk)],
      [`${label} card with no figure named still reads as the directory entry (unchanged)`,
        amb.found === true && asBase(amb.speaker), JSON.stringify(amb)],
    ];
  }),
  ["gas cloud card from an actor with no figure keeps the bare speaker form (token null)",
    r.speaker.gasSolo?.found === true && r.speaker.gasSolo?.speaker?.token === null
      && r.speaker.gasSolo?.speaker?.actor === r.speaker.soloActorId
      && r.speaker.gasSolo?.speaker?.alias === r.speaker.soloAlias,
    JSON.stringify(r.speaker.gasSolo)],
  ["blast card from an actor with no figure keeps the bare speaker form (token null)",
    r.speaker.boomSolo?.found === true && r.speaker.boomSolo?.speaker?.token === null
      && r.speaker.boomSolo?.speaker?.actor === r.speaker.soloActorId
      && r.speaker.boomSolo?.speaker?.alias === r.speaker.soloAlias,
    JSON.stringify(r.speaker.boomSolo)],
  ["the bare-actor reference itself is what the shipped helper produces for that actor",
    r.speaker.refSolo?.token === null && r.speaker.refSolo?.actor === r.speaker.soloActorId,
    JSON.stringify(r.speaker.refSolo)],

  ["suite ran to the end (did not stop on a throw)", !r.err, r.err],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok, why] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${!ok && why ? "  — " + why : ""}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 8));
await b.close();
process.exit(fail ? 1 : 0);
