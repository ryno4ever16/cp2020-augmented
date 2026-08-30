/**
 * Combat-tracker control → DOCUMENT-RESOLUTION SCOPE. :30004 (official 1.1.1 + module).
 *
 * The four tracker controls in module/combat/damage-hooks.js (aim, dodge, parry, add-action) write
 * flags. WHICH document they write to is the whole subject of this suite.
 *
 * A synthetic (unlinked-token) actor SHARES its id with its world actor — the documented id-collision
 * class — so `game.actors.get(btn.dataset.actorId)` cannot distinguish them and always hands back the
 * world actor. Two consequences, both asserted below by value:
 *   · the world actor collects flags no one asked it to hold, and
 *   · every unlinked copy of that one base READS those flags back (a synthetic actor inherits its
 *     base's flags), so a stance declared on one figure bleeds onto its siblings.
 * The fix resolves through the COMBATANT (`combatant.actor`), which is the token's own actor for an
 * unlinked combatant and the world actor for a linked one — so linked behavior must be unchanged.
 *
 *   FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node tests/cp2020-augmented-tracker-flag-scope.mjs
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
  const SCOPE = "cp2020-augmented";
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const out = { err: null, scope: {}, aim: {}, dodge: {}, parry: {}, addAction: {}, linked: {}, read: {}, multi: {} };

  let prevSceneId = null;
  const madeActors = [];
  try {
    // ⏪ the aim / declared-defence / multi-action enablement keys retired 2026-08-29 (settings-trim):
    //    all four behaviours are unconditional now, so this suite snapshots and restores nothing.

    // ── fixtures ───────────────────────────────────────────────────────────────────────────────
    for (const c of [...game.combats]) if (c.combatants.some(cb => cb.name?.startsWith?.("__PW__Scope"))) await c.delete().catch(() => {});
    for (const a of game.actors.filter(a => a.name?.startsWith?.("__PW__Scope"))) await a.delete().catch(() => {});
    for (const s of [...game.scenes]) if (s.name?.startsWith?.("__PW__Scope")) await s.delete().catch(() => {});

    prevSceneId = game.scenes.active?.id ?? null;
    const [scene] = await Scene.create([{
      name: "__PW__ScopeScene", width: 2000, height: 2000, padding: 0,
      grid: { size: 100, type: CONST.GRID_TYPES.SQUARE },
    }]);
    await scene.activate();
    for (let i = 0; i < 150 && !(canvas?.ready && canvas.scene?.id === scene.id); i++) await sleep(200);
    const G = scene.grid?.size ?? 100;

    const mk = async (name) => {
      const a = await Actor.create({ name, type: "character" });
      await a.update({ "system.stats.ref.base": 6 });
      madeActors.push(a);
      return a;
    };
    // ONE base actor, three figures of it: two UNLINKED copies (each keeps its own flags) and one
    // LINKED figure (which IS the world actor). The pair of unlinked copies is what makes a
    // world-directory write visible as a BLEED rather than a harmless extra write.
    const base = await mk("__PW__ScopeBase");
    const attacker = await mk("__PW__ScopeSwinger");
    const [knife] = await attacker.createEmbeddedDocuments("Item", [{
      name: "__PW__ScopeKnife", type: "weapon",
      system: { equipped: true, weaponType: "Melee", attackType: "Melee", damage: "1d6", accuracy: 0 } }]);
    // A second weapon on the BASE, so every figure of it reads the item back as ITS OWN. The
    // multi-action prefill keys off the weapon's actor, so this is what lets (D2) below open a window
    // that belongs to one unlinked figure rather than to the world actor.
    await base.createEmbeddedDocuments("Item", [{
      name: "__PW__ScopeCounterKnife", type: "weapon",
      system: { equipped: true, weaponType: "Melee", attackType: "Melee", damage: "1d6", accuracy: 0 } }]);

    const [tokU1] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__ScopeU1", actorId: base.id, actorLink: false, x: 3 * G, y: 2 * G, width: 1, height: 1 }]);
    const [tokU2] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__ScopeU2", actorId: base.id, actorLink: false, x: 5 * G, y: 2 * G, width: 1, height: 1 }]);
    const [tokL1] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__ScopeL1", actorId: base.id, actorLink: true,  x: 7 * G, y: 2 * G, width: 1, height: 1 }]);
    await sleep(400);

    const u1 = canvas.tokens.get(tokU1.id).actor;
    const u2 = canvas.tokens.get(tokU2.id).actor;
    const l1 = canvas.tokens.get(tokL1.id).actor;

    // ── (0) the root cause, stated as an assertion ─────────────────────────────────────────────
    // An id lookup diverges from the token's own document for an unlinked figure and converges for a
    // linked one. Everything below is the consequence of that one fact.
    out.scope.unlinkedIdLookupDiverges = game.actors.get(u1.id) !== u1;
    out.scope.unlinkedSharesBaseId     = u1.id === base.id;
    out.scope.linkedIdLookupConverges  = game.actors.get(l1.id) === l1 && l1 === base;
    out.scope.siblingsAreDistinctDocs  = u1 !== u2;

    const combat = await Combat.create({});
    const cbs = await combat.createEmbeddedDocuments("Combatant", [
      { tokenId: tokU1.id, sceneId: scene.id, actorId: base.id, name: "__PW__ScopeU1", initiative: 30 },
      { tokenId: tokU2.id, sceneId: scene.id, actorId: base.id, name: "__PW__ScopeU2", initiative: 20 },
      { tokenId: tokL1.id, sceneId: scene.id, actorId: base.id, name: "__PW__ScopeL1", initiative: 10 },
    ]);
    const cU1 = combat.combatants.find(c => c.name === "__PW__ScopeU1");
    const cU2 = combat.combatants.find(c => c.name === "__PW__ScopeU2");
    const cL1 = combat.combatants.find(c => c.name === "__PW__ScopeL1");
    out.scope.combatantActorIsTokenActor = cU1.actor === u1 && cU2.actor === u2;
    out.scope.combatantActorIsWorldActor = cL1.actor === base;

    await combat.activate();
    await combat.startCombat();
    await sleep(600);
    try { ui.sidebar?.expand?.(); ui.sidebar?.activateTab?.("combat"); } catch (_e) { /* headless sidebar */ }

    const turnTo = async (combatant) => {
      const idx = combat.turns.findIndex(c => c.id === combatant.id);
      if (idx >= 0 && combat.turn !== idx) await combat.update({ turn: idx });
      await sleep(400);
      ui.combat?.render(true);
      await sleep(700);
    };
    /** The control on ONE tracker row. The row is found by Foundry's own `data-combatant-id` on the
     *  list item, so the lookup works identically before and after the fix — the suite never depends
     *  on the attribute under test to find the thing under test. */
    const rowBtn = (combatant, cls) => {
      for (const li of document.querySelectorAll(`li[data-combatant-id="${combatant.id}"]`)) {
        const el = li.querySelector(cls);
        if (el) return el;
      }
      return null;
    };
    const raw = (doc, key) => doc.getFlag(SCOPE, key) ?? null;
    /** What a TOKEN's own ActorDelta records — the write's landing site, read straight off the token
     *  document rather than through the synthetic actor. A synthetic actor INHERITS its base actor's
     *  flags wherever its delta says nothing, so `tokenActor.getFlag(...)` alone cannot tell a write
     *  that landed on the token from one that landed on the world actor and was inherited back. The
     *  delta can: only a write to the token's own document appears here. */
    const delta = (tokDoc, key) => {
      const src = tokDoc.delta?._source ?? tokDoc.delta?.toObject?.() ?? {};
      const v = foundry.utils.getProperty(src, `flags.${SCOPE}.${key}`);
      return v === undefined ? null : v;
    };
    const clearAll = async () => {
      for (const d of [base, u1, u2, l1]) {
        for (const k of ["aimRounds", "dodging", "parrying", "actionCount", "actionCountRound"]) {
          await d.unsetFlag(SCOPE, k).catch(() => {});
        }
      }
      await sleep(300);
    };

    // ── (A) take-aim control ───────────────────────────────────────────────────────────────────
    await clearAll();
    await turnTo(cU1);

    const aimBtn = rowBtn(cU1, ".cp-take-aim-btn");
    out.aim.rendered      = !!aimBtn;
    out.aim.combatantId   = aimBtn?.dataset?.combatantId || "";
    out.aim.combatantIdOk = (aimBtn?.dataset?.combatantId || "") === cU1.id;
    aimBtn?.click();
    for (let i = 0; i < 50 && raw(u1, "aimRounds") === null; i++) await sleep(120);
    await sleep(400);
    out.aim.tokenActor = raw(u1, "aimRounds");     // expected 1
    out.aim.worldActor = raw(base, "aimRounds");   // expected null — the world actor is not a party to this
    out.aim.sibling    = raw(u2, "aimRounds");     // expected null — the other copy is untouched
    await clearAll();

    // ── (B) dodge control ──────────────────────────────────────────────────────────────────────
    await turnTo(cU1);
    const dodgeBtn = rowBtn(cU1, ".cp-dodge-btn");
    out.dodge.rendered      = !!dodgeBtn;
    out.dodge.combatantIdOk = (dodgeBtn?.dataset?.combatantId || "") === cU1.id;
    dodgeBtn?.click();
    for (let i = 0; i < 50 && raw(u1, "dodging") !== true; i++) await sleep(120);
    await sleep(400);
    out.dodge.tokenActor = raw(u1, "dodging");
    out.dodge.worldActor = raw(base, "dodging");
    out.dodge.sibling    = raw(u2, "dodging");
    // The landing site itself: the click's write is recorded on THIS token's delta and on no other.
    out.dodge.deltaWritten = delta(tokU1, "dodging");
    out.dodge.deltaSibling = delta(tokU2, "dodging");

    // ── (B2) the READ side meets the write ─────────────────────────────────────────────────────
    // The declared-defence prefill resolves the target through its TOKEN. With the stance standing on
    // U1 only, U1's dialog folds the book −2 and the SIBLING's dialog must be untouched — the sibling
    // leg is the one a world-directory write cannot pass.
    const openAndRead = async (item, tokenIds) => {
      const res = { found: false, val: null, noteCount: 0, err: null };
      let dlg = null;
      try {
        for (const t of [...(game.user?.targets ?? [])]) t.setTarget(false, { releaseOthers: false, groupSelection: true });
        await sleep(120);
        for (const id of tokenIds) canvas.tokens.get(id)?.setTarget(true, { releaseOthers: false, groupSelection: true });
        await sleep(200);
        dlg = attacker.sheet._cpOpenAttackModifiers(item);
        await sleep(900);
        const root = dlg?.element ?? null;
        const inp = root?.querySelector?.("input[name='extraMod']") ?? null;
        res.found = !!inp;
        res.val = inp ? String(inp.value ?? "") : null;
        res.noteCount = (root?.querySelectorAll?.(".cp-declared-defense .cp-declared-defense-note") ?? []).length;
      } catch (e) { res.err = String(e?.message ?? e); }
      try { await dlg?.close?.({ animate: false }); } catch (_e) { /* already gone */ }
      await sleep(200);
      return res;
    };
    // ⚠ THE COUNTER IS CLEARED FIRST, and that is a consequence of the trim: declaring the stance
    //    also SPENDS an action, and since 2026-08-29 the multi-action prefill is unconditional and seeds
    //    the SAME `extraMod` field. Left standing, the count would put its own term in the field beside
    //    the stance's and this leg would read two folds as one. The counter's own fold is driven
    //    deliberately in (D2). The stance flag itself is untouched by the clear.
    for (const d of [base, u1, u2, l1]) {
      await d.unsetFlag(SCOPE, "actionCount").catch(() => {});
      await d.unsetFlag(SCOPE, "actionCountRound").catch(() => {});
    }
    await sleep(300);
    out.read.declaredFigure = await openAndRead(knife, [tokU1.id]);   // expected -2, 1 note
    out.read.siblingFigure  = await openAndRead(knife, [tokU2.id]);   // expected untouched, 0 notes
    for (const t of [...(game.user?.targets ?? [])]) t.setTarget(false, { releaseOthers: false, groupSelection: true });

    // ── (B3) second act: the same control again clears on the same document ────────────────────
    ui.combat?.render(true); await sleep(700);
    rowBtn(cU1, ".cp-dodge-btn")?.click();
    for (let i = 0; i < 50 && raw(u1, "dodging") === true; i++) await sleep(120);
    await sleep(400);
    out.dodge.clearedTokenActor = raw(u1, "dodging");   // expected null
    out.dodge.worldStillClean   = raw(base, "dodging"); // expected null
    await clearAll();

    // ── (C) parry control — driven on a NON-active row (parry renders for every combatant) ─────
    await turnTo(cU1);
    const parryBtn = rowBtn(cU2, ".cp-parry-btn");
    out.parry.rendered      = !!parryBtn;
    out.parry.combatantIdOk = (parryBtn?.dataset?.combatantId || "") === cU2.id;
    parryBtn?.click();
    for (let i = 0; i < 50 && raw(u2, "parrying") !== true; i++) await sleep(120);
    await sleep(400);
    out.parry.tokenActor = raw(u2, "parrying");
    out.parry.worldActor = raw(base, "parrying");
    out.parry.sibling    = raw(u1, "parrying");

    // (C2) second act across TWO figures. The control is a TOGGLE that reads the flag back before it
    // decides, so a world-directory write cannot express two figures at once: the second row's click
    // would read the FIRST row's flag and cancel it instead of setting its own. Parry is the control
    // used here because it renders on every row, active or not.
    ui.combat?.render(true); await sleep(700);
    rowBtn(cU1, ".cp-parry-btn")?.click();
    for (let i = 0; i < 50 && raw(u1, "parrying") !== true; i++) await sleep(120);
    await sleep(400);
    out.parry.bothDeclared = { first: raw(u1, "parrying"), second: raw(u2, "parrying"), world: raw(base, "parrying") };

    // (C3) cancelling ONE figure leaves the other standing.
    ui.combat?.render(true); await sleep(700);
    rowBtn(cU1, ".cp-parry-btn")?.click();
    for (let i = 0; i < 50 && raw(u1, "parrying") === true; i++) await sleep(120);
    await sleep(400);
    out.parry.oneCancelled = { cancelled: raw(u1, "parrying"), other: raw(u2, "parrying"), world: raw(base, "parrying") };
    await clearAll();

    // ── (D) add-action control ─────────────────────────────────────────────────────────────────
    await turnTo(cU1);
    const addBtn = rowBtn(cU1, ".cp-add-action-btn");
    out.addAction.rendered      = !!addBtn;
    out.addAction.combatantIdOk = (addBtn?.dataset?.combatantId || "") === cU1.id;
    addBtn?.click();
    for (let i = 0; i < 50 && raw(u1, "actionCount") === null; i++) await sleep(120);
    await sleep(500);
    out.addAction.tokenActor = raw(u1, "actionCount");   // expected 1
    out.addAction.worldActor = raw(base, "actionCount"); // expected null
    out.addAction.sibling    = raw(u2, "actionCount");   // expected null

    // ── (D2) THE COUNT IS SPOKEN ALOUD IN THE ROLL WINDOW ───────────────────────────
    // NEW 2026-08-29 with the trim. The count used to fold silently into `extraMod` and stop there - a
    // number that moved with nothing on screen saying why. It now lands the way the declared-defence
    // term does: the value seeds the same editable field AND a labeled line names the figure, which
    // action of the round is being declared, and the number that was seeded. Read by value off the REAL
    // window, on the FIGURE that holds the count (the window is opened with that figure's own copy of
    // the base weapon, which is what the prefill keys off):
    //   (a) the line renders under its own marker class and quotes the declaring count,
    //   (b) the field carries the book's term for that count,
    //   (c) typing over the field wins - the seed is not a lock,
    //   (d) and with the switch OFF none of it happens - no line, and the field left unseeded.
    // One action already stands on U1 from the control above, so this window is action TWO and the
    // p.98 ladder puts -3 in the field.
    //
    // ↪ THE SWITCH IS PINNED, not inherited (2026-08-29, the restore). `multiActionPenaltyEnabled`
    //    was cut with the trim and put back the same day, defaulting ON; the penalty helper answers 0
    //    while it is off, so an inherited world value would silently decide every leg below. It is
    //    snapshot here and handed back in this section's own finally - which is also what lets the
    //    (D2b) negative move it honestly.
    const multiWas = (() => { try { return game.settings.get(SCOPE, "multiActionPenaltyEnabled"); } catch { return undefined; } })();
    try {
      await game.settings.set(SCOPE, "multiActionPenaltyEnabled", true);
      await sleep(250);
      {
        const res = { found: false, val: null, noteCount: 0, noteText: "", figureName: null, declaredCount: null, weaponActorIsFigure: null, editable: null, afterEdit: null, err: null };
        let dlg = null;
        try {
          const figureKnife = u1.items.find(i => i.name === "__PW__ScopeCounterKnife") ?? null;
          res.weaponActorIsFigure = figureKnife?.actor === u1;
          res.figureName = u1.name;
          for (const t of [...(game.user?.targets ?? [])]) t.setTarget(false, { releaseOthers: false, groupSelection: true });
          await sleep(120);
          canvas.tokens.get(tokU2.id)?.setTarget(true, { releaseOthers: false, groupSelection: true });
          await sleep(200);
          res.declaredCount = raw(u1, "actionCount");
          dlg = attacker.sheet._cpOpenAttackModifiers(figureKnife);
          await sleep(900);
          const root = dlg?.element ?? null;
          const inp = root?.querySelector?.("input[name='extraMod']") ?? null;
          res.found = !!inp;
          res.val = inp ? String(inp.value ?? "") : null;
          const notes = root?.querySelectorAll?.(".cp-multi-action-note .cp-multi-action-note-line") ?? [];
          res.noteCount = notes.length;
          res.noteText = notes[0]?.textContent?.trim() ?? "";
          if (inp) {
            res.editable = inp.readOnly === false && inp.disabled === false;
            inp.value = "-1";
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            inp.dispatchEvent(new Event("change", { bubbles: true }));
            await sleep(300);
            res.afterEdit = String(root?.querySelector?.("input[name='extraMod']")?.value ?? "");
          }
        } catch (e) { res.err = String(e?.message ?? e); }
        try { await dlg?.close?.({ animate: false }); } catch (_e) { /* already gone */ }
        for (const t of [...(game.user?.targets ?? [])]) t.setTarget(false, { releaseOthers: false, groupSelection: true });
        await sleep(200);
        out.multi = res;
      }

      // ── (D2b) THE SWITCH OFF: the same gesture, and the window says nothing ───────────────
      // The same figure, the same standing count, the same weapon and the same target - only the switch
      // moves. The helper returns 0 with it off, so the hook bails before it reaches either the field or
      // the template: NO line, and `extraMod` left on the value it rendered with. The prior value is READ
      // BACK from the window rather than assumed empty, so the leg states "unchanged" rather than a guess
      // about what the field starts at.
      {
        const res = { found: false, valAfter: null, noteCount: 0, declaredCount: null, err: null };
        let dlg = null;
        try {
          await game.settings.set(SCOPE, "multiActionPenaltyEnabled", false);
          await sleep(250);
          const figureKnife = u1.items.find(i => i.name === "__PW__ScopeCounterKnife") ?? null;
          for (const t of [...(game.user?.targets ?? [])]) t.setTarget(false, { releaseOthers: false, groupSelection: true });
          await sleep(120);
          canvas.tokens.get(tokU2.id)?.setTarget(true, { releaseOthers: false, groupSelection: true });
          await sleep(200);
          res.declaredCount = raw(u1, "actionCount");
          dlg = attacker.sheet._cpOpenAttackModifiers(figureKnife);
          await sleep(900);
          const root = dlg?.element ?? null;
          const inp = root?.querySelector?.("input[name='extraMod']") ?? null;
          res.found = !!inp;
          // The contrast partner is (D2)'s own reading on the identical gesture: -3 with the switch on,
          // unseeded with it off. That is what makes "no seed" a value rather than an absence.
          res.valAfter = inp ? String(inp.value ?? "") : null;
          res.noteCount = (root?.querySelectorAll?.(".cp-multi-action-note") ?? []).length;
        } catch (e) { res.err = String(e?.message ?? e); }
        try { await dlg?.close?.({ animate: false }); } catch (_e) { /* already gone */ }
        for (const t of [...(game.user?.targets ?? [])]) t.setTarget(false, { releaseOthers: false, groupSelection: true });
        await sleep(200);
        out.multiOff = res;
      }
    } finally {
      // Hand the switch back on every exit path, including a thrown leg.
      try { if (multiWas !== undefined) await game.settings.set(SCOPE, "multiActionPenaltyEnabled", multiWas); } catch (_e) { /* unregistered */ }
      await sleep(200);
    }
    out.multiRestored = (() => { try { return game.settings.get(SCOPE, "multiActionPenaltyEnabled") === multiWas; } catch { return null; } })();

    await clearAll();

    // ── (E) LINKED parity: the same controls, the same document as before the change ───────────
    // For a linked combatant `combatant.actor` IS the world actor, so the resolved write target must
    // be byte-identical to what the id lookup produced. Asserted as document IDENTITY, not by id.
    await turnTo(cL1);
    const lDodge = rowBtn(cL1, ".cp-dodge-btn");
    out.linked.rendered       = !!lDodge;
    out.linked.actorIdStamped = (lDodge?.dataset?.actorId || "") === base.id;
    out.linked.resolvesToWorld = game.actors.get(lDodge?.dataset?.actorId || "") === cL1.actor;
    lDodge?.click();
    for (let i = 0; i < 50 && raw(base, "dodging") !== true; i++) await sleep(120);
    await sleep(400);
    out.linked.worldActorWritten = raw(base, "dodging");     // expected true — unchanged behavior
    out.linked.viaLinkedToken    = raw(l1, "dodging");       // same document, same value

    const lAim = rowBtn(cL1, ".cp-take-aim-btn");
    lAim?.click();
    for (let i = 0; i < 50 && raw(base, "aimRounds") === null; i++) await sleep(120);
    await sleep(400);
    out.linked.aimWorldActor = raw(base, "aimRounds");       // expected 1
    // The linked click must write NOTHING onto the unlinked tokens' own documents. It is stated on the
    // deltas, not on the synthetic actors: a flag standing on the world actor is INHERITED by every
    // unlinked copy of it (Foundry's data model, not this module's write path), so `u1.getFlag(...)`
    // legitimately reads back the linked figure's declaration and could never be asserted clean here.
    out.linked.noDeltaOnUnlinked = delta(tokU1, "dodging") === null && delta(tokU2, "dodging") === null
                                && delta(tokU1, "aimRounds") === null && delta(tokU2, "aimRounds") === null;

    await clearAll();
    await combat.delete().catch(() => {});
    await scene.delete().catch(() => {});
  } catch (e) { out.err = String(e?.message ?? e); }
  finally {
    for (const a of madeActors) await a.delete().catch(() => {});
    for (const s of [...game.scenes]) if (s.name?.startsWith?.("__PW__Scope")) await s.delete().catch(() => {});
    for (const c of [...game.combats]) if (c.combatants.some(cb => cb.name?.startsWith?.("__PW__Scope"))) await c.delete().catch(() => {});
    if (prevSceneId) await game.scenes.get(prevSceneId)?.activate().catch(() => {});
  }
  return out;
});

console.log(JSON.stringify(r, null, 1));
// "Untouched" must mean the window RENDERED and read as zero — a window that never opened cannot pass
// a negative leg by returning nothing (the vacuous-leg rule).
const noFold = (x) => !!x && x.found === true && !x.err && (x.val === "" || x.val === "0");
const checks = [
  // (0) root cause
  ["id lookup diverges from the unlinked figure's own document (and it shares the base id)",
    r.scope.unlinkedIdLookupDiverges === true && r.scope.unlinkedSharesBaseId === true],
  ["id lookup converges for the linked figure (its document IS the world actor)",
    r.scope.linkedIdLookupConverges === true],
  ["the two unlinked figures are distinct documents", r.scope.siblingsAreDistinctDocs === true],
  ["combatant.actor is the token's actor when unlinked, the world actor when linked",
    r.scope.combatantActorIsTokenActor === true && r.scope.combatantActorIsWorldActor === true],

  // (A) aim
  ["aim control renders on the unlinked row carrying a non-empty combatant id",
    r.aim.rendered === true && (r.aim.combatantId ?? "") !== "" && r.aim.combatantIdOk === true],
  ["aim write lands on the token's actor (value 1)", r.aim.tokenActor === 1],
  ["aim write does NOT land on the world actor", r.aim.worldActor === null],
  ["aim write does NOT reach the sibling figure", r.aim.sibling === null],

  // (B) dodge
  ["dodge control renders on the unlinked row with the right combatant id",
    r.dodge.rendered === true && r.dodge.combatantIdOk === true],
  ["dodge write lands on the token's actor (true)", r.dodge.tokenActor === true],
  ["dodge write does NOT land on the world actor", r.dodge.worldActor === null],
  ["dodge write does NOT reach the sibling figure", r.dodge.sibling === null],
  ["landing site: the write is recorded on that token's OWN delta and on no other token's",
    r.dodge.deltaWritten === true && r.dodge.deltaSibling === null],
  ["second act — the same control clears on the token's actor, world actor still clean",
    r.dodge.clearedTokenActor === null && r.dodge.worldStillClean === null],

  // (B2) write meets read
  ["read path: the declaring figure's melee window folds -2 with one note",
    r.read.declaredFigure?.val === "-2" && r.read.declaredFigure?.noteCount === 1],
  ["read path NEGATIVE: the sibling figure's window is untouched, no note",
    noFold(r.read.siblingFigure) && r.read.siblingFigure?.noteCount === 0],

  // (C) parry
  ["parry control renders on a non-active unlinked row with the right combatant id",
    r.parry.rendered === true && r.parry.combatantIdOk === true],
  ["parry write lands on that row's token actor (true)", r.parry.tokenActor === true],
  ["parry write does NOT land on the world actor", r.parry.worldActor === null],
  ["parry write does NOT reach the sibling figure", r.parry.sibling === null],
  ["second act — both unlinked figures can stand declared at once (world actor still clean)",
    r.parry.bothDeclared?.first === true && r.parry.bothDeclared?.second === true && r.parry.bothDeclared?.world === null],
  ["second act — cancelling one figure leaves the other standing (world actor still clean)",
    r.parry.oneCancelled?.cancelled === null && r.parry.oneCancelled?.other === true && r.parry.oneCancelled?.world === null],

  // (D) add-action
  ["add-action control renders on the unlinked row with the right combatant id",
    r.addAction.rendered === true && r.addAction.combatantIdOk === true],
  ["add-action counter lands on the token's actor (value 1)", r.addAction.tokenActor === 1],
  ["add-action counter does NOT land on the world actor", r.addAction.worldActor === null],
  ["add-action counter does NOT reach the sibling figure", r.addAction.sibling === null],

  // (D2) the count at the point of use - the trim's one new gesture leg
  ["prefilled modifier row: the window is opened with the FIGURE's own copy of the weapon",
    r.multi?.weaponActorIsFigure === true],
  ["prefilled modifier row: one action stands on that figure, so this window declares action two",
    r.multi?.declaredCount === 1, r.multi?.declaredCount],
  ["prefilled modifier row: the labeled line renders under its own marker class, exactly once",
    r.multi?.found === true && r.multi?.noteCount === 1, r.multi?.err ?? r.multi?.noteCount],
  ["prefilled modifier row: the line names the figure it quotes, by that document's own name",
    !!r.multi?.figureName && (r.multi?.noteText ?? "").includes(r.multi.figureName), r.multi?.noteText],
  ["prefilled modifier row: and it quotes the count being declared beside the seeded term",
    /\baction\s+2\b/i.test(r.multi?.noteText ?? "") && /-3/.test(r.multi?.noteText ?? ""), r.multi?.noteText],
  ["prefilled modifier row: the field carries the book's term for that count (-3)",
    r.multi?.val === "-3", r.multi?.val],
  ["prefilled modifier row: typing over the field wins - the seed is not a lock",
    r.multi?.editable === true && r.multi?.afterEdit === "-1", `editable=${r.multi?.editable} after=${r.multi?.afterEdit}`],
  // (D2b) the switch's OFF state - restored 2026-08-29, so it has one again
  ["prefilled modifier row NEGATIVE: the switch off, the same standing count still on the figure",
    r.multiOff?.declaredCount === 1, r.multiOff?.declaredCount],
  ["prefilled modifier row NEGATIVE: the window opens and renders NO labeled line",
    r.multiOff?.found === true && r.multiOff?.noteCount === 0, r.multiOff?.err ?? r.multiOff?.noteCount],
  ["prefilled modifier row NEGATIVE: and the modifier field is left on its unseeded value",
    r.multiOff?.valAfter === "" || r.multiOff?.valAfter === "0", r.multiOff?.valAfter],
  ["prefilled modifier row: the switch was handed back to the value the section found",
    r.multiRestored === true, String(r.multiRestored)],

  // (E) linked parity
  ["linked row: the stamped actor id still resolves to the same document the control writes",
    r.linked.rendered === true && r.linked.actorIdStamped === true && r.linked.resolvesToWorld === true],
  ["linked row: dodge writes the world actor exactly as before (true, same document)",
    r.linked.worldActorWritten === true && r.linked.viaLinkedToken === true],
  ["linked row: aim writes the world actor exactly as before (value 1)", r.linked.aimWorldActor === 1],
  ["linked row writes no delta onto the unlinked tokens' own documents", r.linked.noDeltaOnUnlinked === true],

  ["suite ran to the end (did not stop on a throw)", !r.err, r.err],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok, why] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${!ok && why ? "  — " + why : ""}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
