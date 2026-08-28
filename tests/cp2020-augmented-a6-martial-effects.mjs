/**
 * A6/D2 — martial hit-effects wired to the live path (:30004, official 1.1.1 + module).
 *
 * The grapple/choke/hold enforcement (choke DOT + Stun Save, hold/grapple per-turn reminders) is
 * already live in damage-hooks; only the trigger was dead. Now the live martial dialog
 * (_cpOpenMartialActionDialog onConfirm) applies the effect on-declare to a single target, GM-relayed.
 *
 * Behavioural: drive the (now live) applyMartialHitEffects and assert the exact flags the per-turn
 * loop reads (heldBy / grappledBy / chokeState), the escape clear, and the specialMeleeEffectsEnabled
 * gate. Source-shape: the onConfirm wiring + the martialEffect relay case.
 *
 * Also GEOMETRY: the dialog that action opens has to fit. Two dropdowns whose longest options are
 * a martial-art name and a cyber-terminus label used to size the two-column field row wider than the
 * content box, and .window-content clips overflow-x, so the second one ran off the window edge. The
 * legs measure the real render at the shipped width and again narrowed.
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-a6-martial-effects.mjs
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

async function joinAs(page, match, passwords) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 30_000 });
  const users = await sel.locator("option").evaluateAll((o) =>
    o.map((x) => ({ v: x.value, l: (x.textContent || "").trim() })).filter((x) => x.v));
  const u = users.find((x) => match.test(x.l));
  if (!u) throw new Error("no user matching " + match);
  for (const pw of passwords) {
    await sel.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([
      page.waitForNavigation({ url: /\/game/, timeout: 15_000 }).catch(() => {}),
      page.locator('button[name="join"]').click(),
    ]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 15_000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await sel.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join as " + u.l);
}

const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push("console: " + m.text()); });
  await joinAs(page, /^gamemaster$/i, [GM_PW]);

  const R = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const SCOPE = "cp2020-augmented";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    let atk = null, tgt = null, prevMelee;
    try {
      const flag = (a, k) => a.getFlag(SCOPE, k);

      // source-shape: the wiring is in the served code. The relay emit lives in its single home
      // (martial.js applyOrRelayMartialEffect — the sheet and the offer-card buttons both delegate).
      const asheet = await (await fetch(`${M}/actor/actor-sheet.js`, { cache: "no-store" })).text();
      ok("A6 onConfirm calls the effect helper", /_cpApplyOrRelayMartialEffect\(action, targetActor\)/.test(asheet), true);
      const msrc = await (await fetch(`${M}/martial/martial.js`, { cache: "no-store" })).text();
      ok("A6 helper emits martialEffect relay", /type: "martialEffect"/.test(msrc), true);
      const dhooks = await (await fetch(`${M}/combat/damage-hooks.js`, { cache: "no-store" })).text();
      ok("A6 damage-hooks handles martialEffect", /data\.type === "martialEffect"/.test(dhooks), true);

      // behavioural: drive the now-live effect writer
      const MA = await import(`${M}/martial/martial.js`);
      prevMelee = game.settings.get(SCOPE, "specialMeleeEffectsEnabled");
      await game.settings.set(SCOPE, "specialMeleeEffectsEnabled", true);

      // Pre-sweep a prior run's leftovers (non-__PW__ names → not caught by a shared sweep).
      for (const x of game.actors.filter(x => x.name === "GRIG Attacker" || x.name === "GRIG Target")) await x.delete().catch(() => {});
      atk = await Actor.create({ name: "GRIG Attacker", type: "character" });
      tgt = await Actor.create({ name: "GRIG Target",   type: "character" });

      await MA.applyMartialHitEffects("Hold", tgt, atk);
      ok("A6 Hold sets heldBy = attacker", flag(tgt, "heldBy") === atk.id, flag(tgt, "heldBy"));
      await MA.applyMartialHitEffects("Grapple", tgt, atk);
      ok("A6 Grapple sets grappledBy = attacker", flag(tgt, "grappledBy") === atk.id, flag(tgt, "grappledBy"));
      await MA.applyMartialHitEffects("Choke", tgt, atk);
      const choke = flag(tgt, "chokeState");
      ok("A6 Choke sets chokeState (with formula)", !!choke && !!choke.formula, JSON.stringify(choke));
      await MA.applyMartialHitEffects("Escape", tgt, atk);
      ok("A6 Escape clears held/grapple/choke",
        !flag(tgt, "heldBy") && !flag(tgt, "grappledBy") && !flag(tgt, "chokeState"),
        `${flag(tgt,"heldBy")}/${flag(tgt,"grappledBy")}/${flag(tgt,"chokeState")}`);

      // gate: off → no-op
      await game.settings.set(SCOPE, "specialMeleeEffectsEnabled", false);
      await MA.applyMartialHitEffects("Hold", tgt, atk);
      ok("A6 gate off → Hold is a no-op", !flag(tgt, "heldBy"), flag(tgt, "heldBy"));

      // ── coord(4): a martial strike (item.__weaponRoll → base __martialBonk) now emits the use-event
      //    payload WITH its OWN attackerId — the seam-shim wraps __martialBonk (FIRE_METHODS), so the
      //    strike sets a FRESH _fireCtx (never the last ranged fire's stale identity) and the shared
      //    multi-action counter increments for the MARTIAL actor. Source-shape proves the wrap; the
      //    counter proves the downstream attribution (driven via the same weaponFired the shim emits). ──
      const shimSrc = await (await fetch(`${M}/seam-shim.js`, { cache: "no-store" })).text();
      const hasMartialBonk = /FIRE_METHODS\s*=\s*\[[^\]]*"__martialBonk"/.test(shimSrc);
      ok("coord4 seam-shim wraps __martialBonk (fresh fire-ctx → no stale ranged attackerId)", hasMartialBonk, hasMartialBonk);
      let prevMAP, prevMAT;
      try { prevMAP = game.settings.get(SCOPE, "multiActionPenaltyEnabled"); await game.settings.set(SCOPE, "multiActionPenaltyEnabled", true); } catch {}
      try { prevMAT = game.settings.get(SCOPE, "multiActionAutoTrack"); await game.settings.set(SCOPE, "multiActionAutoTrack", true); } catch {}
      const ctOf = (a) => Number(a.getFlag(SCOPE, "actionCount") ?? 0);
      // The action counter is COMBAT-SCOPED now (walkthrough fix #1): it only accrues inside a started
      // combat the striker is a combatant in. Stand up a minimal combat around the emit (the old
      // out-of-combat emit correctly leaves the count at 0 — that's the new intended default).
      let coordCombat = null;
      try {
        coordCombat = await Combat.create({});
        await coordCombat.createEmbeddedDocuments("Combatant", [{ actorId: atk.id, name: atk.name }]);
        await coordCombat.activate();
        await coordCombat.startCombat();
        await new Promise(r => setTimeout(r, 300));
      } catch (e) { out.error = "coord4 combat setup: " + (e?.message || e); }
      const ct0 = ctOf(atk);
      Hooks.callAll("cyberpunk2020.weaponFired", { attackerId: atk.id, weaponName: "Karate", areaDamages: { Torso: [{ damage: 1 }] } });
      for (let i = 0; i < 30 && ctOf(atk) === ct0; i++) await new Promise(r => setTimeout(r, 100));
      ok("coord4 martial-attributed weaponFired increments the multi-action counter for the striker (in-combat)", ctOf(atk) === ct0 + 1, `${ct0}->${ctOf(atk)}`);
      ok("coord4 the counter credits only the emitting actor (no cross-actor identity leak)", ctOf(tgt) === 0, ctOf(tgt));
      try { await atk.unsetFlag(SCOPE, "actionCount"); await atk.unsetFlag(SCOPE, "actionCountRound"); } catch {}
      try { if (coordCombat) await coordCombat.delete(); } catch {}
      try { if (prevMAP !== undefined) await game.settings.set(SCOPE, "multiActionPenaltyEnabled", prevMAP); } catch {}
      try { if (prevMAT !== undefined) await game.settings.set(SCOPE, "multiActionAutoTrack", prevMAT); } catch {}
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    } finally {
      try { if (tgt) await tgt.delete(); } catch {}
      try { if (atk) await atk.delete(); } catch {}
      try { if (prevMelee !== undefined) await game.settings.set(SCOPE, "specialMeleeEffectsEnabled", prevMelee); } catch {}
    }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("A6 martial hit-effects\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(44)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;

  // ── The dialog the martial action opens has to FIT. Geometry, measured on the real render. ──────
  // The two dropdowns' longest options used to size the two-column grid past the content box, and
  // .window-content clips overflow-x, so the second one ran off the window edge. Both widths are
  // checked: one width green is false confidence on a window whose size can change.
  const G = await page.evaluate(async () => {
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let actor = null, sheet = null, app = null;
    try {
      const L = await import("/modules/cp2020-augmented/module/lookups.js");
      for (const a of game.actors.filter(a => a.name === "__PW__DialogFit")) await a.delete().catch(() => {});
      actor = await Actor.create({ name: "__PW__DialogFit", type: "character" });
      const martials = actor.items.filter(i => i.type === "skill" && L.isMartialArtSkillItem?.(i));
      ok("fixture carries martial-art skill documents", martials.length > 0, martials.length);
      await actor.updateEmbeddedDocuments("Item", martials.map(i => ({ _id: i.id, "system.level": 4 })));
      const choices = L.martialOptions(actor)[0][0].choices;
      ok("the dropdown offers every trained art, not just the default", choices.length > 1, choices.length);

      sheet = actor.sheet;
      await sheet.render(true);
      await sleep(1200);
      sheet._cpOpenMartialActionDialog({ dataset: { action: "strike" } });
      await sleep(1400);
      app = [...foundry.applications.instances.values()].find(a => a.element?.querySelector?.(".weapon-modifiers"));
      ok("the martial action opened the modifiers dialog", !!app, !!app);
      if (!app) return out;

      const survey = (tag) => {
        const root = app.element;
        const win = root.getBoundingClientRect();
        const list = root.querySelector(".field-list");
        const selects = [...root.querySelectorAll("select")];
        return {
          tag,
          winRight: win.right,
          listFits: list.scrollWidth <= list.clientWidth,
          listScroll: list.scrollWidth, listClient: list.clientWidth,
          selectMinWidths: selects.map(s => getComputedStyle(s).minWidth),
          past: selects.filter(s => s.getBoundingClientRect().right > win.right + 0.5).map(s => s.name),
          outsideRow: selects.filter(s => {
            const f = s.closest(".field");
            return f && s.getBoundingClientRect().right > f.getBoundingClientRect().right + 0.5;
          }).map(s => s.name),
          count: selects.length,
        };
      };

      const wide = survey("default");
      // THREE dropdowns since the called-shot row was restored (2026-08-13). The overflow this section
      // was written for was measured with two, so the count is pinned: a third track on the same row is
      // strictly the harder case, and a silent drop back to two would mean the row went missing again.
      ok("three dropdowns are on the row (the case that used to overflow, now one wider)", wide.count === 3, wide.count);
      ok("every dropdown declares a zero floor so its track can shrink",
        wide.selectMinWidths.every(v => v === "0px"), wide.selectMinWidths.join("/"));
      ok("the field row fits its own box at the shipped width",
        wide.listFits, `scroll ${wide.listScroll} vs client ${wide.listClient}`);
      ok("no dropdown reaches past the window edge at the shipped width",
        wide.past.length === 0, wide.past.join(",") || "none");
      ok("no dropdown reaches past its own row at the shipped width",
        wide.outsideRow.length === 0, wide.outsideRow.join(",") || "none");

      app.setPosition({ width: 340 });
      await sleep(600);
      const narrow = survey("narrowed");
      ok("the field row still fits when the window is narrowed",
        narrow.listFits, `scroll ${narrow.listScroll} vs client ${narrow.listClient}`);
      ok("no dropdown reaches past the window edge when narrowed",
        narrow.past.length === 0, narrow.past.join(",") || "none");
      ok("no dropdown reaches past its own row when narrowed",
        narrow.outsideRow.length === 0, narrow.outsideRow.join(",") || "none");
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    } finally {
      try { if (app) await app.close(); } catch {}
      try { if (sheet) await sheet.close(); } catch {}
      try { if (actor) await actor.delete(); } catch {}
    }
    return out;
  });
  if (G.error) { console.error("IN-PAGE ERROR (geometry):", G.error); failures++; }
  console.log("\nattack-modifiers dialog fit\n" + G.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(60)} got=${c.got}`).join("\n"));
  failures += G.checks.filter(c => !c.pass).length;

  // ── THE DECLARED AREA (2026-08-13). The base system charges −4 to hit for naming a location and then
  //    puts the damage THERE instead of rolling for it; the dialog row that declares it is the base's own
  //    `targetArea` field, read by `__martialBonk` in two places. Our combat-tab button panel replaced the
  //    base's Action dropdown and the row went out with it, so from then until this unit every unarmed
  //    strike was un-aimable: the modifier was permanently 0 and the location was always rolled.
  //
  //    Both legs drive the REAL dialog and read the REAL card. The modifier is read as the roll's
  //    constant part (total minus every die's total), which is exact regardless of what the dice did —
  //    the two runs differ by exactly 4 and by nothing else, because nothing else about them differs.
  const A = await page.evaluate(async () => {
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let actor = null, sheet = null, weaponId = null;
    const AREAS = ["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"];
    try {
      const L = await import("/modules/cp2020-augmented/module/lookups.js");
      for (const a of game.actors.filter(a => a.name === "__PW__CalledShot")) await a.delete().catch(() => {});
      actor = await Actor.create({ name: "__PW__CalledShot", type: "character" });

      /* structural: the row is in the table, at the base system's own path and semantics */
      const rows = L.martialOptions(actor).flat();
      const row = rows.find(r => r.dataPath === "targetArea");
      ok("the modifier table carries the base system's targetArea row", !!row, row ? "present" : "ABSENT");
      ok("it offers every hit location and no called shot by default",
        !!row && row.allowBlank === true && row.defaultValue === "" && AREAS.every(a => row.choices.includes(a)),
        row ? `allowBlank=${row.allowBlank} default=${JSON.stringify(row.defaultValue)} choices=${row.choices}` : "n/a");

      // A damage-bearing implement: the base takes the roll-only path for an action that deals none, and
      // the location is only resolved on the damaging path, so an empty-handed fixture would measure
      // nothing. `Martial` is the base's own melee attack type for this route.
      const made = await actor.createEmbeddedDocuments("Item", [{
        name: "__PW__Fist", type: "weapon",
        system: { attackType: "Martial", weaponType: "Melee", damage: "1d6", accuracy: 0 },
      }]);
      weaponId = made[0].id;

      sheet = actor.sheet;
      await sheet.render(true);
      await sleep(1200);

      /** Open the dialog, write the area (null = leave blank), submit, and read back the card. */
      const strike = async (area) => {
        const seen = [];
        const hookId = Hooks.on("cyberpunk2020.weaponFired", p => seen.push(p));
        const before = new Set(game.messages.map(m => m.id));
        sheet._cpOpenMartialActionDialog({ dataset: { action: "Strike", itemId: weaponId } });
        await sleep(1400);
        const dlg = [...foundry.applications.instances.values()]
          .find(a => a.element?.querySelector?.(".weapon-modifiers"));
        const sel = dlg?.element?.querySelector('select[name="targetArea"], select[name="fields.targetArea"]');
        const optionValues = sel ? [...sel.options].map(o => o.value) : null;
        if (sel && area !== null) { sel.value = area; sel.dispatchEvent(new Event("change", { bubbles: true })); }
        const wrote = sel?.value ?? null;
        const btn = dlg?.element?.querySelector('button.fire, button[type="submit"]');
        if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        for (let i = 0; i < 60 && !seen.length; i++) await sleep(100);
        await sleep(600);
        Hooks.off("cyberpunk2020.weaponFired", hookId);
        const card = [...game.messages].reverse().find(m => !before.has(m.id) && (m.rolls?.length ?? 0) > 0);
        const atk = card?.rolls?.[0] ?? null;
        // The constant part of the attack roll: everything the dice did not contribute.
        const constants = atk
          ? Number(atk.total) - atk.dice.reduce((s, d) => s + Number(d.total), 0)
          : null;
        try { await dlg?.close?.(); } catch (e) { /* already closed */ }
        return { optionValues, wrote, constants,
          locations: Object.keys(seen[0]?.areaDamages ?? {}), cardId: card?.id ?? null };
      };

      const head = await strike("Head");
      ok("the dialog offers the row with a blank first choice and all six locations",
        Array.isArray(head.optionValues) && head.optionValues[0] === "" && AREAS.every(a => head.optionValues.includes(a)),
        head.optionValues === null ? "NO SUCH SELECT — the row never rendered" : head.optionValues.join("/"));
      ok("the declared area is the one the field holds at submit", head.wrote === "Head", head.wrote);
      ok("a declared area is the area that takes the damage — no location roll",
        head.locations.length === 1 && head.locations[0] === "Head", head.locations.join(",") || "none");

      const blank = await strike(null);
      ok("leaving it blank declares nothing, and the location is rolled from the table",
        blank.locations.length === 1 && AREAS.includes(blank.locations[0]), blank.locations.join(",") || "none");
      ok("declaring an area costs exactly 4 off the attack, and blank costs nothing",
        head.constants !== null && blank.constants !== null && (blank.constants - head.constants) === 4,
        `blank ${blank.constants} vs declared ${head.constants} (difference ${blank.constants - head.constants}, expected 4)`);

      for (const id of [head.cardId, blank.cardId]) {
        if (id) { try { await game.messages.get(id)?.delete(); } catch (e) { /* gone */ } }
      }
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    } finally {
      try { if (sheet) await sheet.close(); } catch {}
      try { if (actor) await actor.delete(); } catch {}
    }
    return out;
  });
  if (A.error) { console.error("IN-PAGE ERROR (called shot):", A.error); failures++; }
  console.log("\nmartial called shot\n" + A.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(60)} got=${c.got}`).join("\n"));
  failures += A.checks.filter(c => !c.pass).length;

  // ── PER-ACTION ITEM RESOLUTION (issue #2). The consolidated panel stamps ONE item id on every
  //    row (the actor's first martial-arts weapon), and the base system takes the DAMAGE off the
  //    ITEM — so an actor owning several martial items had every button roll whichever item sorted
  //    first, creation-order dependent. The sheet now resolves the item PER ACTION at click time on
  //    a three-rung ladder (catalog source pointer → exact name → the stamped fallback).
  //
  //    Every leg reads the damage formula the base actually built off the resolved item, taken from
  //    the produced card's inline damage roll — a value, not a selection the test asserted itself.
  const P = await page.evaluate(async () => {
    const out = { checks: [], notes: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
    const STRIKE_UUID ="Compendium.cyberpunk2020.melee.Item.TZoiQuE8fUzJ8Jta";
    const KICK_UUID   = "Compendium.cyberpunk2020.melee.Item.TF0nBrjofPX2RiuG";
    const PANEL_ACTIONS = ["Dodge", "BlockParry", "AllOutParry", "AllOutDodge", "Strike", "Punch",
      "Kick", "Disarm", "SweepTrip", "Ram", "JumpKick", "Cast", "Grapple", "Hold", "Choke",
      "Throw", "Escape"];
    let actor = null, sheet = null;
    const cards = [];
    try {
      const L = await import("/modules/cp2020-augmented/module/lookups.js");

      // ── The pinned table vs the INSTALLED pack: the ladder's top rung is only as good as its
      //    UUIDs, and a closed sweep of every base pack proves the table is complete, not just
      //    correct. Strike and Kick are the only catalog items whose name is a panel action.
      const table = L.MARTIAL_ACTION_CATALOG_UUID ?? {};
      const meleeIdx = [...(await game.packs.get("cyberpunk2020.melee").getIndex())];
      const byName = (n) => meleeIdx.find(e => e.name === n);
      ok("pinned Strike UUID matches the installed melee pack entry",
        byName("Strike") && `Compendium.cyberpunk2020.melee.Item.${byName("Strike")._id}` === STRIKE_UUID,
        byName("Strike")?._id);
      ok("pinned Kick UUID matches the installed melee pack entry",
        byName("Kick") && `Compendium.cyberpunk2020.melee.Item.${byName("Kick")._id}` === KICK_UUID,
        byName("Kick")?._id);
      ok("the shipped table pins exactly those two, by UUID",
        table.Strike === STRIKE_UUID && table.Kick === KICK_UUID && Object.keys(table).length === 2,
        JSON.stringify(table));
      const sweep = [];
      for (const p of game.packs.filter(p => p.metadata.packageName === "cyberpunk2020" && p.documentName === "Item")) {
        for (const e of await p.getIndex()) if (PANEL_ACTIONS.includes(String(e.name ?? "").trim())) sweep.push(`${p.collection}:${e.name}`);
      }
      ok("closed sweep of the base packs finds no third action-named catalog item",
        sweep.length === 2 && sweep.every(s => s.startsWith("cyberpunk2020.melee:")), sweep.join(",") || "none");
      ok("NEGATIVE: an action with no catalog item (Throw) is deliberately unpinned",
        table.Throw === undefined, table.Throw);

      for (const a of game.actors.filter(a => a.name === "__PW__MartialItem")) await a.delete().catch(() => {});
      actor = await Actor.create({ name: "__PW__MartialItem", type: "character" });
      await sleep(400);
      sheet = actor.sheet;
      await sheet.render(true);
      await sleep(1200);

      ok("the sheet carries a per-action item resolver",
        typeof sheet._cpResolveMartialActionItem === "function", typeof sheet._cpResolveMartialActionItem);

      /** Wipe every weapon/cyberware fixture so the next case owns its own creation order. */
      const clearGear = async () => {
        const ids = actor.items.filter(i => i.type === "weapon" || i.type === "cyberware").map(i => i.id);
        if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
        await sleep(200);
      };
      const dropCatalog = async (uuid, patch) => {
        const doc = await Item.implementation.fromDropData({ type: "Item", uuid });
        const [it] = await actor.createEmbeddedDocuments("Item", [doc.toObject()]);
        if (patch) await it.update(patch);
        return it;
      };
      const handMade = async (name, damage) => {
        const [it] = await actor.createEmbeddedDocuments("Item", [{
          name, type: "weapon",
          system: { attackType: "Martial", weaponType: "Melee", damage, accuracy: 0 },
        }]);
        return it;
      };
      /** The id the TEMPLATE stamps on every panel row: the actor's first martial-arts weapon. */
      const stampedId = () => actor.items.find(i => i.type === "weapon" && i.system?.attackType === "Martial")?.id ?? "";

      /** Drive the dialog the panel row opens, submit it, and read the damage formula the base
       *  built off whatever item was resolved. `head` is the formula's leading term — the item's
       *  own damage, before the strength / martial bonuses the base appends. */
      const rollFor = async (action, itemId) => {
        const before = new Set(game.messages.map(m => m.id));
        sheet._cpOpenMartialActionDialog({ dataset: { action, itemId: itemId ?? stampedId() } });
        await sleep(1300);
        const dlg = [...foundry.applications.instances.values()].find(a => a.element?.querySelector?.(".weapon-modifiers"));
        const btn = dlg?.element?.querySelector('button.fire, button[type="submit"]');
        if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        let card = null;
        for (let i = 0; i < 60 && !card; i++) { await sleep(100); card = [...game.messages].reverse().find(m => !before.has(m.id)); }
        await sleep(300);
        try { await dlg?.close?.(); } catch (e) { /* already closed */ }
        if (card) cards.push(card.id);
        const m = /<a class="[^"]*\bdamage\b[^"]*"\s+data-roll="([^"]+)"/.exec(card?.content ?? "");
        let formula = null;
        if (m) { try { formula = JSON.parse(decodeURIComponent(m[1]))?.formula ?? null; } catch (e) { formula = null; } }
        return { opened: !!dlg, hasDamage: !!m, formula, head: formula ? norm(formula).split("+")[0] : null };
      };

      // ── Case 1: both catalog items owned, KICK CREATED FIRST (the reported order). ──
      await clearGear();
      const k1 = await dropCatalog(KICK_UUID);
      const s1 = await dropCatalog(STRIKE_UUID);
      ok("the dropped catalog copies carry the v12+ source pointer",
        s1._stats?.compendiumSource === STRIKE_UUID && k1._stats?.compendiumSource === KICK_UUID,
        `${s1._stats?.compendiumSource} / ${k1._stats?.compendiumSource}`);
      ok("the stamped panel id is the FIRST-created item — one id for every row",
        stampedId() === k1.id, stampedId() === k1.id ? "kick" : "strike");
      const c1s = await rollFor("Strike");
      const c1k = await rollFor("Kick");
      ok("Kick first: the Strike row rolls the catalog Strike's damage", c1s.head === "1d6/2", c1s.formula);
      ok("Kick first: the Kick row rolls the catalog Kick's damage", c1k.head === "1d6", c1k.formula);

      // ── Case 2: the same pair, STRIKE CREATED FIRST — the answer must not move. ──
      await clearGear();
      const s2 = await dropCatalog(STRIKE_UUID);
      await dropCatalog(KICK_UUID);
      ok("the stamped panel id flipped with the creation order (the input that used to decide)",
        stampedId() === s2.id, stampedId() === s2.id ? "strike" : "kick");
      const c2s = await rollFor("Strike");
      const c2k = await rollFor("Kick");
      ok("Strike first: the Strike row still rolls the catalog Strike's damage", c2s.head === "1d6/2", c2s.formula);
      ok("Strike first: the Kick row still rolls the catalog Kick's damage", c2k.head === "1d6", c2k.formula);

      // ── Case 3: rung 1 is NAME-BLIND — a renamed, re-statted catalog copy still answers. ──
      await clearGear();
      await dropCatalog(STRIKE_UUID, { name: "Super Punch", "system.damage": "3D6" });
      const c3 = await rollFor("Strike");
      ok("a renamed catalog Strike still answers the Strike row, at its edited damage",
        c3.head === "3d6", c3.formula);

      // ── Case 4: rung 2 — an exact, case-insensitive name, no source pointer. ──
      await clearGear();
      await handMade("strike", "4D6");
      const c4 = await rollFor("Strike");
      ok("a hand-made item named exactly Strike resolves on the name rung", c4.head === "4d6", c4.formula);

      // ── Case 5: both rungs match different items — rung 1 wins, silently. ──
      await clearGear();
      await handMade("Strike", "4D6");
      await dropCatalog(STRIKE_UUID, { name: "Super Punch", "system.damage": "3D6" });
      const c5 = await rollFor("Strike");
      ok("catalog pointer outranks an exact name match on the same action", c5.head === "3d6", c5.formula);

      // ── Case 6: NEGATIVE — a name that merely CONTAINS the action never matches. ──
      await clearGear();
      const nova = await handMade("Nova Strike", "5D6");
      const k6 = await dropCatalog(KICK_UUID);
      const c6 = await rollFor("Strike", k6.id);
      ok("a containing name is not a match — the Strike row does not roll Nova Strike",
        c6.head !== "5d6", c6.formula);
      ok("with nothing better, the stamped fallback item is what fires (unchanged behaviour)",
        c6.head === "1d6", c6.formula);
      ok("NEGATIVE: the resolver reports no per-action match for this actor",
        sheet._cpResolveMartialActionItem?.("Strike", "") == null, sheet._cpResolveMartialActionItem?.("Strike", "")?.name);
      ok("an action with neither rung falls through to the stamped id",
        sheet._cpResolveMartialActionItem?.("BlockParry", nova.id)?.id === nova.id,
        sheet._cpResolveMartialActionItem?.("BlockParry", nova.id)?.name);

      // ── Case 7: two catalog Strikes — the equipped copy wins, in both directions. ──
      await clearGear();
      const dup1 = await dropCatalog(STRIKE_UUID, { "system.damage": "7D6", "system.equipped": false });
      const dup2 = await dropCatalog(STRIKE_UUID, { "system.damage": "8D6", "system.equipped": true });
      const c7a = await rollFor("Strike");
      ok("two catalog copies: the equipped one is the one that fires", c7a.head === "8d6", c7a.formula);
      await dup1.update({ "system.equipped": true });
      await dup2.update({ "system.equipped": false });
      await sleep(200);
      const c7b = await rollFor("Strike");
      ok("moving the equipped mark moves the answer with it", c7b.head === "7d6", c7b.formula);

      // ── Case 8: Throw — no catalog item exists, so the name rung carries it. ──
      await clearGear();
      await dropCatalog(KICK_UUID);
      await handMade("Throw", "2D6");
      const c8 = await rollFor("Throw");
      ok("Throw resolves on the name rung even with another martial item owned", c8.head === "2d6", c8.formula);

      // ── Case 9: no martial items at all — the stand-in is a CLONE of the system's catalog entry,
      //    so an empty-handed action still rolls the system's own damage for it. Actions with no
      //    catalog entry, and actions that deal no damage, keep the bare stand-in's behaviour. ──
      await clearGear();
      const c9s = await rollFor("Strike", "");
      const c9k = await rollFor("Kick", "");
      ok("with no owned martial item the dialog still opens", c9s.opened, c9s.opened);
      ok("empty-handed Strike rolls the catalog entry's damage", c9s.head === "1d6/2", c9s.formula);
      ok("empty-handed Kick rolls the catalog entry's damage", c9k.head === "1d6", c9k.formula);
      // An action with NO catalog entry now takes its damage from the mirrored maneuver table
      // instead of the base template's "2d6+1" default (the table section below is the full matrix).
      const c9t = await rollFor("Throw", "");
      ok("an action with no catalog entry takes the mirrored table value on its stand-in (Throw)",
        c9t.hasDamage === true && norm(c9t.formula).startsWith("1d6+"), c9t.formula);
      const c9d = await rollFor("SweepTrip", "");
      ok("NEGATIVE: a non-damaging action still posts the roll-only card", c9d.hasDamage === false, c9d.formula);

      // ── Case 9b: the same path reached by DELETION, not by never owning one. ──
      await clearGear();
      const gone = await dropCatalog(STRIKE_UUID, { "system.damage": "6D6" });
      const c9b1 = await rollFor("Strike");
      ok("while owned, the owned copy's own damage is what fires", c9b1.head === "6d6", c9b1.formula);
      await actor.deleteEmbeddedDocuments("Item", [gone.id]);
      await sleep(200);
      const c9b2 = await rollFor("Strike", "");
      ok("once deleted, the row falls to the catalog stand-in rather than to nothing",
        c9b2.head === "1d6/2", c9b2.formula);

      // ── AUDIT (report, never fail): the catalog's damage vs Core p.111, text-layer verified.
      //    A disagreement here is a DATA finding about the base system's pack, not a defect in this
      //    code — the no-mass-patching policy governs what happens next, so the leg records it. ──
      const BOOK_P111 = { Strike: "1D6/2", Kick: "1D6", Throw: "1D6" };
      const melee = game.packs.get("cyberpunk2020.melee");
      for (const [act, want] of Object.entries(BOOK_P111)) {
        const e = byName(act);
        if (!e) { out.notes.push(`no catalog entry named "${act}" — book p.111 gives ${want}; its stand-in is served by the mirrored maneuver table instead`); continue; }
        const doc = await melee.getDocument(e._id);
        const got = String(doc?.system?.damage ?? "").trim();
        if (norm(got) !== norm(want)) out.notes.push(`catalog "${act}" damage ${JSON.stringify(got)} vs book p.111 ${JSON.stringify(want)}`);
      }
      // Every action the base pays damage for (item.js damagingMartialActions) that has no catalog
      // entry is served by the mirrored maneuver table instead — recorded here, exercised below.
      const DAMAGING = ["Strike", "Punch", "Kick", "JumpKick", "Ram", "Cast", "Throw", "Choke"];
      const unpinned = DAMAGING.filter(a => !table[a]);
      if (unpinned.length) out.notes.push(`damage-bearing actions with no catalog entry (stand-in damage comes from the mirrored maneuver table): ${unpinned.join(", ")}`);
      ok("catalog damage audited against Core p.111 (findings are reported, not failed)", true,
        out.notes.length ? `${out.notes.length} finding(s)` : "no discrepancy");

      // ── WIRING: the rendered rows still stamp one id, and a real click on the Strike row lands
      //    on the resolved item — the resolver, not the template, is doing the work. ──
      await clearGear();
      await dropCatalog(KICK_UUID);
      await dropCatalog(STRIKE_UUID, { "system.damage": "9D6" });
      await sheet.render(false);
      await sleep(1000);
      const rows = [...(sheet.element?.querySelectorAll(".martial-action") ?? [])];
      const strikeRow = rows.find(r => r.dataset.action === "Strike");
      const kickRow = rows.find(r => r.dataset.action === "Kick");
      ok("the panel renders a row per action, each carrying an action key",
        rows.length > 0 && rows.every(r => !!r.dataset.action), rows.length);
      ok("every rendered row still stamps the same single item id (the defect's input, kept)",
        !!strikeRow && !!kickRow && strikeRow.dataset.itemId === kickRow.dataset.itemId && !!strikeRow.dataset.itemId,
        `${strikeRow?.dataset?.itemId} / ${kickRow?.dataset?.itemId}`);
      const beforeClick = new Set(game.messages.map(m => m.id));
      strikeRow?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await sleep(1300);
      const dlg = [...foundry.applications.instances.values()].find(a => a.element?.querySelector?.(".weapon-modifiers"));
      dlg?.element?.querySelector('button.fire, button[type="submit"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      let clickCard = null;
      for (let i = 0; i < 60 && !clickCard; i++) { await sleep(100); clickCard = [...game.messages].reverse().find(m => !beforeClick.has(m.id)); }
      await sleep(300);
      try { await dlg?.close?.(); } catch (e) { /* already closed */ }
      if (clickCard) cards.push(clickCard.id);
      const cm = /<a class="[^"]*\bdamage\b[^"]*"\s+data-roll="([^"]+)"/.exec(clickCard?.content ?? "");
      let clickHead = null;
      if (cm) { try { clickHead = norm(JSON.parse(decodeURIComponent(cm[1]))?.formula).split("+")[0]; } catch (e) { clickHead = null; } }
      ok("a real click on the Strike row rolls the Strike item's damage, not the stamped one",
        clickHead === "9d6", clickHead);
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    } finally {
      for (const id of cards) { try { await game.messages.get(id)?.delete(); } catch (e) { /* gone */ } }
      try { if (sheet) await sheet.close(); } catch {}
      try { if (actor) await actor.delete(); } catch {}
    }
    return out;
  });
  if (P.error) { console.error("IN-PAGE ERROR (per-action item):", P.error); failures++; }
  console.log("\nmartial per-action item resolution\n" + P.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(68)} got=${c.got}`).join("\n"));
  if (P.notes?.length) console.log("  catalog-data findings (reported, not failed):\n" + P.notes.map(n => `    - ${n}`).join("\n"));
  failures += P.checks.filter(c => !c.pass).length;

  // ── UNARMED MANEUVER DAMAGE TABLES. Six damage-bearing actions have no catalog item, so their
  //    empty-handed stand-in used to inherit the base weapon template's default "2d6+1" — every one
  //    of Punch / JumpKick / Ram / Cast / Throw / Choke rolled the same wrong number bare-fisted.
  //    The stand-in now carries the maneuver's own damage, from the tables mirrored verbatim from
  //    the upstream system's v1.2.0-dev (lookups.js). Legs read the formula the base actually built,
  //    off the produced card — never the table the module just handed it.
  const U = await page.evaluate(async () => {
    const out = { checks: [], notes: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
    const SCOPE = "cp2020-augmented";
    const KICK_UUID = "Compendium.cyberpunk2020.melee.Item.TF0nBrjofPX2RiuG";
    let actor = null, sheet = null, prevFnff2 = null;
    const cards = [];
    try {
      const L = await import("/modules/cp2020-augmented/module/lookups.js");
      // The FNFF2 toggle is DUAL-SCOPE: the base system owns the key where it registers one and the
      // module keeps an inert shadow for installs that don't (lookups.js isFnff2Enabled reads the
      // system's copy first). Writing the shadow on a base that owns the real key changes nothing —
      // resolve the authoritative scope the way presets.js does, or the gate legs test nothing.
      const GATE_SCOPE = (() => {
        try { if (game.settings.settings.has("cyberpunk2020.fnff2Enabled")) return "cyberpunk2020"; } catch (e) { /* not registered */ }
        return SCOPE;
      })();
      out.notes.push(`the FNFF2 toggle is owned by "${GATE_SCOPE}" on this rig`);
      prevFnff2 = game.settings.get(GATE_SCOPE, "fnff2Enabled");
      const setGate = async (on) => {
        await game.settings.set(GATE_SCOPE, "fnff2Enabled", on);
        for (let i = 0; i < 40 && game.settings.get(GATE_SCOPE, "fnff2Enabled") !== on; i++) await sleep(100);
        return game.settings.get(GATE_SCOPE, "fnff2Enabled");
      };

      // ── The mirror itself: the values, not just that a table exists. ──
      await setGate(true);
      ok("core maneuver table mirrors upstream exactly (4 entries, by value)",
        JSON.stringify(L.unarmedManeuverDamage) === JSON.stringify({ Strike: "1D6/2", Kick: "1D6", Throw: "1D6", Choke: "1D6" }),
        JSON.stringify(L.unarmedManeuverDamage));
      ok("FNFF2 maneuver table mirrors upstream exactly (3 entries, by value)",
        JSON.stringify(L.unarmedManeuverDamageFNFF2) === JSON.stringify({ Punch: "1D6/2", JumpKick: "1D6+5", Cast: "1D6" }),
        JSON.stringify(L.unarmedManeuverDamageFNFF2));
      ok("the Jump Kick's automatic to-hit price is -5", L.JUMP_KICK_TO_HIT === -5, L.JUMP_KICK_TO_HIT);

      const RAM_BANDS = [[1, "1D6-2"], [2, "1D6-2"], [3, "1D6-1"], [4, "1D6-1"], [5, "1D6"], [6, "2D6"],
        [7, "2D6"], [8, "2D6+1"], [9, "2D6+1"], [10, "2D6+2"], [11, "3D6+4"], [12, "3D6+4"],
        [13, "3D6+6"], [14, "3D6+6"], [15, "3D6+8"], [16, "4D6+8"], [20, "4D6+8"], [21, "5D6+8"], [25, "9D6+8"]];
      const badBand = RAM_BANDS.filter(([b, want]) => L.ramDamageFormula(b) !== want);
      ok("the Ram chart answers every band by BODY, incl. the +1D6-per-point tail past 20",
        badBand.length === 0, badBand.map(([b, w]) => `${b}:${L.ramDamageFormula(b)}!=${w}`).join(",") || `${RAM_BANDS.length} bands`);
      ok("the Ram chart's BODY-12 row matches the book's own worked example (3D6+4)",
        L.ramDamageFormula(12) === "3D6+4", L.ramDamageFormula(12));

      // ── NO DOUBLE BODY. The base composes `<damage> + @strengthBonus + …`, and the Ram chart's
      //    additive column already IS that bonus — the stand-in must hand over the dice alone. ──
      const doubled = [];
      for (let b = 1; b <= 25; b++) {
        const bonus = Number(L.strengthDamageBonus(b)) || 0;
        const signed = bonus > 0 ? `+${bonus}` : (bonus < 0 ? String(bonus) : "");
        if (`${L.unarmedStandInDamage("Ram", b)}${signed}` !== L.ramDamageFormula(b)) doubled.push(b);
      }
      ok("stand-in Ram damage + the bonus the base appends reconstructs the chart at every BODY 1-25",
        doubled.length === 0, doubled.join(",") || "25/25");
      ok("NEGATIVE: a flat-die maneuver is written through untouched (no column to strip)",
        L.unarmedStandInDamage("Kick", 12) === "1D6" && L.unarmedStandInDamage("Strike", 12) === "1D6/2",
        `${L.unarmedStandInDamage("Kick", 12)} / ${L.unarmedStandInDamage("Strike", 12)}`);

      // ── The ruleset gate, at the resolver. ──
      const gateOff = await setGate(false);
      const offAnswers = ["Punch", "JumpKick", "Cast", "Ram"].filter(a => L.unarmedManeuverFormula(a, 12) !== undefined);
      ok("the FNFF2 toggle reads back OFF before the gate legs", gateOff === false, gateOff);
      ok("gate OFF: the FNFF2 maneuvers and Ram are priced by no table", offAnswers.length === 0, offAnswers.join(",") || "none");
      ok("gate OFF: the CORE four are priced anyway (no corebook maneuver sits behind the toggle)",
        ["Strike", "Kick", "Throw", "Choke"].every(a => !!L.unarmedManeuverFormula(a, 12)), "4/4");
      await setGate(true);
      ok("gate ON: all seven priced maneuvers answer",
        ["Strike", "Kick", "Throw", "Choke", "Punch", "JumpKick", "Cast"].every(a => !!L.unarmedManeuverFormula(a, 12))
        && L.unarmedManeuverFormula("Ram", 12) === "3D6+4", L.unarmedManeuverFormula("Ram", 12));

      // ── Fixture. ──
      for (const a of game.actors.filter(a => a.name === "__PW__Maneuver")) await a.delete().catch(() => {});
      actor = await Actor.create({ name: "__PW__Maneuver", type: "character" });
      await sleep(400);
      sheet = actor.sheet;
      await sheet.render(true);
      await sleep(1200);

      const setBody = async (n) => {
        await actor.update({ "system.stats.bt.base": n });
        await sleep(250);
        return actor.system?.stats?.bt?.total;
      };
      const clearGear = async () => {
        const ids = actor.items.filter(i => i.type === "weapon" || i.type === "cyberware").map(i => i.id);
        if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
        await sleep(200);
      };
      /** Drive the panel row's dialog empty-handed and read BOTH rolls the base built: the damage
       *  formula off the card's inline damage roll, and the attack formula off the card's own roll. */
      const rollFor = async (action, itemId = "") => {
        const before = new Set(game.messages.map(m => m.id));
        sheet._cpOpenMartialActionDialog({ dataset: { action, itemId } });
        await sleep(1300);
        const dlg = [...foundry.applications.instances.values()].find(a => a.element?.querySelector?.(".weapon-modifiers"));
        dlg?.element?.querySelector('button.fire, button[type="submit"]')
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        let card = null;
        for (let i = 0; i < 60 && !card; i++) { await sleep(100); card = [...game.messages].reverse().find(m => !before.has(m.id)); }
        await sleep(300);
        try { await dlg?.close?.(); } catch (e) { /* already closed */ }
        if (card) cards.push(card.id);
        const m = /<a class="[^"]*\bdamage\b[^"]*"\s+data-roll="([^"]+)"/.exec(card?.content ?? "");
        let dmg = null;
        if (m) { try { dmg = norm(JSON.parse(decodeURIComponent(m[1]))?.formula); } catch (e) { dmg = null; } }
        return { hasDamage: !!m, dmg, attack: norm(card?.rolls?.[0]?.formula ?? "") };
      };

      // ── Which stand-in each action gets: the catalog clone where one is pinned, the bare
      //    stand-in carrying table damage where none is. Rung order, read off the built document. ──
      await clearGear();
      const tsStrike = await sheet._cpBuildTransientMartialItem("Strike");
      const tsPunch = await sheet._cpBuildTransientMartialItem("Punch");
      ok("a pinned action still gets the CATALOG clone, not a table-stamped stand-in (ladder intact)",
        tsStrike?.name === "Strike" && norm(tsStrike?.system?.damage) === "1d6/2", `${tsStrike?.name}:${tsStrike?.system?.damage}`);
      ok("an unpinned action gets the bare stand-in stamped with its table damage",
        tsPunch?.name !== "Strike" && norm(tsPunch?.system?.damage) === "1d6/2", `${tsPunch?.name}:${tsPunch?.system?.damage}`);

      // ── Gate ON, empty-handed: every one of the six now rolls its own table value. ──
      //    The base composes `<stand-in damage> + @strengthBonus + @martialDamageBonus`; at BODY 12
      //    that is "+4+0" (Brawling pays no martial damage bonus), so every expectation below is the
      //    WHOLE formula, not a prefix — "2d6+1+…" would otherwise satisfy a "2d6+1"-shaped test.
      const bt12 = await setBody(12);
      ok("fixture BODY set to 12 (the band the book's worked example prints)", bt12 === 12, bt12);
      const wantOn = { Punch: "1d6/2+4+0", Cast: "1d6+4+0", Throw: "1d6+4+0", Choke: "1d6+4+0", JumpKick: "1d6+5+4+0" };
      for (const [action, want] of Object.entries(wantOn)) {
        const r = await rollFor(action);
        ok(`empty-handed ${action} rolls its table value (was the template default 2d6+1)`,
          r.hasDamage && r.dmg === want, `${r.dmg} want=${want}`);
      }
      const ram12 = await rollFor("Ram");
      ok("empty-handed Ram at BODY 12 rolls the chart's band with BODY counted ONCE (3d6 + 4)",
        ram12.hasDamage && ram12.dmg === "3d6+4+0", `${ram12.dmg} want=3d6+4+0`);
      const bt8 = await setBody(8);
      const ram8 = await rollFor("Ram");
      ok("fixture BODY moved to 8", bt8 === 8, bt8);
      ok("empty-handed Ram at BODY 8 rolls the OTHER band (2d6 + 1), so the chart is read per actor",
        ram8.hasDamage && ram8.dmg === "2d6+1+0", `${ram8.dmg} want=2d6+1+0`);

      // ── The Jump Kick's automatic to-hit price, in the attack roll the card carries. ──
      const jk = await rollFor("JumpKick");
      const plainKick = await rollFor("Kick");
      //    Foundry renders the negative additional-modifier term as "- 5", so the whole formula is
      //    reported alongside: a plain Kick's is all "+ 0" terms.
      ok("the Jump Kick's attack roll carries the automatic -5", jk.attack.includes("-5"), jk.attack);
      ok("NEGATIVE: a plain Kick's attack roll carries no such term", !plainKick.attack.includes("-5"), plainKick.attack);

      // ── Gate OFF: the FNFF2 three and Ram fall back to the base template default; the core two
      //    that have no catalog item keep their corebook value. ──
      //    Still at BODY 8, so the base appends "+1+0".
      await setGate(false);
      for (const action of ["Punch", "JumpKick", "Cast", "Ram"]) {
        const r = await rollFor(action);
        ok(`gate OFF: empty-handed ${action} falls back to the base template default`,
          r.hasDamage && r.dmg === "2d6+1+1+0", `${r.dmg} want=2d6+1+1+0`);
      }
      for (const action of ["Throw", "Choke"]) {
        const r = await rollFor(action);
        ok(`gate OFF: empty-handed ${action} still rolls its corebook value (core is not gated)`,
          r.hasDamage && r.dmg === "1d6+1+0", `${r.dmg} want=1d6+1+0`);
      }
      const jkOff = await rollFor("JumpKick");
      ok("gate OFF: the Jump Kick's attack roll carries no automatic penalty either",
        !jkOff.attack.includes("-5"), jkOff.attack);
      await setGate(true);

      // ── REGRESSION: an OWNED item still outranks the table. Items stay authoritative. ──
      const [ownThrow] = await actor.createEmbeddedDocuments("Item", [{
        name: "Throw", type: "weapon", system: { attackType: "Martial", weaponType: "Melee", damage: "2D6", accuracy: 0 },
      }]);
      await sleep(200);
      const rThrow = await rollFor("Throw", ownThrow.id);
      ok("an owned item named for the action beats the table (items stay authoritative)",
        rThrow.dmg === "2d6+1+0", `${rThrow.dmg} want=2d6+1+0 (table would be 1d6+1+0)`);
      const kickDoc = await Item.implementation.fromDropData({ type: "Item", uuid: KICK_UUID });
      const [ownKick] = await actor.createEmbeddedDocuments("Item", [kickDoc.toObject()]);
      await ownKick.update({ "system.damage": "9D6" });
      await sleep(200);
      const rKick = await rollFor("Kick", ownKick.id);
      ok("an owned catalog copy's edited damage beats both the catalog clone and the table",
        rKick.dmg?.startsWith("9d6"), rKick.dmg);
      await clearGear();

      // ── NEGATIVE: a non-damaging action is still roll-only with the tables live. ──
      const sweep = await rollFor("SweepTrip");
      ok("NEGATIVE: a non-damaging action posts no damage roll (the tables did not widen the set)",
        sweep.hasDamage === false, sweep.dmg);
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    } finally {
      try {
        if (prevFnff2 !== null) {
          const s = game.settings.settings.has("cyberpunk2020.fnff2Enabled") ? "cyberpunk2020" : SCOPE;
          await game.settings.set(s, "fnff2Enabled", prevFnff2);
        }
      } catch (e) { /* unregistered */ }
      for (const id of cards) { try { await game.messages.get(id)?.delete(); } catch (e) { /* gone */ } }
      try { if (sheet) await sheet.close(); } catch {}
      try { if (actor) await actor.delete(); } catch {}
    }
    return out;
  });
  if (U.error) { console.error("IN-PAGE ERROR (unarmed maneuver tables):", U.error); failures++; }
  console.log("\nunarmed maneuver damage tables\n" + U.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(78)} got=${c.got}`).join("\n"));
  failures += U.checks.filter(c => !c.pass).length;

  const errOk = consoleErrors.length === 0;
  console.log(`\n  [${errOk ? "PASS" : "FAIL"}] 0 console errors${errOk ? "" : "  got=" + JSON.stringify(consoleErrors.slice(0, 5))}`);
  if (!errOk) failures++;

  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
