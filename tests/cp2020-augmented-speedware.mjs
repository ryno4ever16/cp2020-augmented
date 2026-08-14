/** SPEEDWARE ACTIVATION FIDELITY — an activated initiative boost runs for its printed span and stops.
 *
 *  What this keeper proves, all by VALUE on the ship-target rig (:30004, vanilla 1.1.1 + module):
 *    • THE PREMISE, asserted rather than assumed — the base pack entry already declares the implant
 *      Activatable beside its +3 payload, and the always-on sibling does not;
 *    • an equipped-but-switched-off boost contributes EXACTLY 0 to the actor's initiative implant
 *      figure, and switching it on contributes exactly its payload (the negative case beside the
 *      positive one);
 *    • the printed clock is read onto the item WITHOUT being written to it — the prepared block says
 *      5 turns while the stored source still says nothing at all;
 *    • the REAL UI GESTURE on the character sheet is what starts it (a click on the row's switch, not
 *      an internal call), and it posts the table's card and raises the token mark;
 *    • it expires after EXACTLY five of the owner's turns — still running at four, gone at five — and
 *      the payload leaves with it;
 *    • the one-boost rule composes: no installation order lets two boosts beat one, and a dormant
 *      boost never taxes the live one into the negative;
 *    • every string the unit added resolves.
 *  Fixture values are the real pack numbers, so the expected sums are the book's own arithmetic. */
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PART 1 — engine values (fixtures built from the real pack documents, torn down at the end).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const r = await p.evaluate(async () => {
  const out = { cleanup: [] };
  const SW = await import("/modules/cp2020-augmented/module/mech/speedware.js");
  const BL = await import("/modules/cp2020-augmented/module/combat/book-legality.js");
  const CON = await import("/modules/cp2020-augmented/module/mech/consumable.js");

  // Real base-pack entries, by id (never by name).
  const P = {
    sandevistan: ["cyberpunk2020.neuralware", "LOCvUXXqo5uFmMn5"],
    kerenzikov1: ["cyberpunk2020.neuralware", "wjnYaHhvxqvRoLs1"],
  };
  const packData = async (key, { equipped = true, active = false } = {}) => {
    const [packId, id] = P[key];
    const doc = await game.packs.get(packId).getDocument(id);
    const data = game.items.fromCompendium(doc);
    data.system = data.system ?? {};
    data.system.equipped = equipped;
    data.system.EffectActive = active;
    return data;
  };

  // ── F1 · THE PREMISE: what the pack entry actually declares ──────────────────────────────────
  // The survey note that opened this unit called the stored data "a passive +3". Read the entry and
  // record what it says, so the claim this whole build rests on is a measurement and not a memory.
  {
    const sande = await game.packs.get(P.sandevistan[0]).getDocument(P.sandevistan[1]);
    const keren = await game.packs.get(P.kerenzikov1[0]).getDocument(P.kerenzikov1[1]);
    out.f1 = {
      sandeName: sande.name,
      sandeMode: sande.system?.EffectMode ?? "",
      sandeInit: Number(sande.system?.CyberWorkType?.Checks?.Initiative) || 0,
      sandeStoredActive: !!sande.system?.EffectActive,
      kerenMode: keren.system?.EffectMode ?? "",
      kerenInit: Number(keren.system?.CyberWorkType?.Checks?.Initiative) || 0,
      // The mechanism predicate must sort them apart without looking at either name.
      sandeIsActivatedBoost: SW.isActivatedInitiativeBoost(sande),
      kerenIsActivatedBoost: SW.isActivatedInitiativeBoost(keren),
    };
  }

  // ── Fixture actor: one character wearing only the Sandevistan ────────────────────────────────
  const actor = await Actor.create({ name: "__PW__Speedware", type: "character" });
  out.cleanup.push(actor.id);
  await actor.createEmbeddedDocuments("Item", [await packData("sandevistan", { active: false })]);
  const sandeItem = actor.items.find(i => Number(i.system?.CyberWorkType?.Checks?.Initiative) === 3);

  // ── F2 · the gate: OFF contributes nothing, ON contributes its payload ───────────────────────
  actor.prepareData();
  const initOff = Number(actor.system?.initiativeImplantMod) || 0;
  await sandeItem.update({ "system.EffectActive": true });
  actor.prepareData();
  const initOn = Number(actor.system?.initiativeImplantMod) || 0;
  await sandeItem.update({ "system.EffectActive": false });
  actor.prepareData();
  const initOffAgain = Number(actor.system?.initiativeImplantMod) || 0;
  out.f2 = { initOff, initOn, initOffAgain };

  // ── F3 · the clock is READ on, never WRITTEN ─────────────────────────────────────────────────
  // `system` is the PREPARED view; `_source` is what is actually stored. The pair is the whole
  // no-writes claim: prepared says 5 turns and un-rationed, stored says the schema default.
  out.f3 = {
    preparedEnabled: !!sandeItem.system?.mechConsumable?.enabled,
    preparedTurns: String(sandeItem.system?.mechConsumable?.durationTurns ?? ""),
    preparedUnlimited: !!sandeItem.system?.mechConsumable?.unlimited,
    preparedNote: String(sandeItem.system?.mechConsumable?.note ?? ""),
    storedEnabled: !!sandeItem._source?.system?.mechConsumable?.enabled,
    storedTurns: String(sandeItem._source?.system?.mechConsumable?.durationTurns ?? ""),
    // The always-on sibling must NOT acquire a clock — it has nothing to switch. Resolved by its
    // PAYLOAD, never by collection index: a new character is auto-populated with ~100 default skill
    // items, so `contents[0]` is a skill and every assertion built on it would be vacuous.
    kerenGetsNoTimer: SW.speedwareTimerFor(
      (await Actor.create({ name: "__PW__SpeedwareKerenProbe", type: "character" })
        .then(async a => { out.cleanup.push(a.id);
          await a.createEmbeddedDocuments("Item", [await packData("kerenzikov1")]);
          return a.items.find(i => Number(i.system?.CyberWorkType?.Checks?.Initiative) === 1); }))) === null,
    // A pack entry that ALREADY declares a block of its own is left alone (the overlay never argues
    // with stored data that speaks for itself).
    respectsOwnBlock: (() => {
      const fake = { type: "cyberware", name: "x",
        system: { EffectMode: "Activatable", CyberWorkType: { Types: ["Characteristic"], Checks: { Initiative: 3 } },
                  mechConsumable: { enabled: true, durationTurns: "9" } } };
      return SW.speedwareTimerFor(fake) === null;
    })(),
  };

  // ── F4 · the one-boost rule, both installation orders ────────────────────────────────────────
  // Order A: the activated boost installed FIRST, the always-on one second.
  const aOrder = await Actor.create({ name: "__PW__SpeedwareOrderA", type: "character" });
  out.cleanup.push(aOrder.id);
  await aOrder.createEmbeddedDocuments("Item", [await packData("sandevistan", { active: false })]);
  await aOrder.createEmbeddedDocuments("Item", [await packData("kerenzikov1")]);
  const aSande = aOrder.items.find(i => Number(i.system?.CyberWorkType?.Checks?.Initiative) === 3);
  aOrder.prepareData();
  const aOff = Number(aOrder.system?.initiativeImplantMod) || 0;
  await aSande.update({ "system.EffectActive": true });
  aOrder.prepareData();
  const aOn = Number(aOrder.system?.initiativeImplantMod) || 0;

  // Order B: the always-on boost installed FIRST, the activated one second.
  const bOrder = await Actor.create({ name: "__PW__SpeedwareOrderB", type: "character" });
  out.cleanup.push(bOrder.id);
  await bOrder.createEmbeddedDocuments("Item", [await packData("kerenzikov1")]);
  await bOrder.createEmbeddedDocuments("Item", [await packData("sandevistan", { active: false })]);
  const bSande = bOrder.items.find(i => Number(i.system?.CyberWorkType?.Checks?.Initiative) === 3);
  bOrder.prepareData();
  const bOff = Number(bOrder.system?.initiativeImplantMod) || 0;
  await bSande.update({ "system.EffectActive": true });
  bOrder.prepareData();
  const bOn = Number(bOrder.system?.initiativeImplantMod) || 0;
  out.f4 = {
    aOff, aOn, bOff, bOn,
    // A dormant activated boost still HOLDS the slot (that is the documented reading) …
    aSlotHolderWhileOff: BL.boosterwareLayers(aOrder).active?.name ?? "",
    bSlotHolderWhileOff: BL.boosterwareLayers(bOrder).active?.name ?? "",
    // … and the surplus subtraction never drives the figure below zero.
    neverNegative: Math.min(aOff, aOn, bOff, bOn) >= 0,
  };

  // ── F5 · un-rationed use: the counter is neither read nor written ────────────────────────────
  out.f5 = {
    unlimited: CON.isUnlimitedUse(sandeItem),
    storedDoses: Number(sandeItem._source?.system?.mechConsumable?.doses ?? -1),
  };

  return out;
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PART 2 — the REAL gesture + the real clock: a sheet click starts it, real combat turns end it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const g = await p.evaluate(async () => {
  const out = { cleanup: [], scenes: [] };
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  const doc = await game.packs.get("cyberpunk2020.neuralware").getDocument("LOCvUXXqo5uFmMn5");
  const data = game.items.fromCompendium(doc);
  data.system = { ...(data.system ?? {}), equipped: true, EffectActive: false };

  const actor = await Actor.create({ name: "__PW__SpeedwareGesture", type: "character" });
  out.cleanup.push(actor.id);
  await actor.createEmbeddedDocuments("Item", [data]);
  const item = actor.items.find(i => Number(i.system?.CyberWorkType?.Checks?.Initiative) === 3);
  out.itemId = item.id;
  out.actorId = actor.id;

  // A linked scene token, so the combat tick's `combat.combatant.actor` IS this actor
  // (TokenDocument.create defaults actorLink:false — the documented harness gotcha).
  const scene = await Scene.create({ name: "__PW__SpeedwareScene", width: 1000, height: 1000 });
  out.scenes.push(scene.id);
  const [tok] = await scene.createEmbeddedDocuments("Token", [{
    name: actor.name, actorId: actor.id, actorLink: true, x: 100, y: 100
  }]);
  out.tokenId = tok.id;

  // Render the real character sheet and find the row's switch — the control a player clicks.
  actor.sheet.render(true);
  await sleep(1500);
  const root = actor.sheet.element instanceof HTMLElement ? actor.sheet.element : actor.sheet.element?.[0];
  // The cyberware tab must be showing for its rows to exist.
  const tab = root?.querySelector('[data-tab="cyberware"], a.item[data-tab="cyberware"]');
  if (tab) { tab.click(); await sleep(600); }
  const sw = root?.querySelector(`.cp-cyber-switch[data-item-id="${item.id}"]`);
  out.switchFound = !!sw;
  out.switchTitleBefore = sw?.getAttribute("title") ?? "";
  out.switchOnBefore = !!sw?.classList?.contains("is-on");

  const msgsBefore = new Set(game.messages.contents.map(m => m.id));

  // ⭐ THE REAL GESTURE: dispatch a genuine click on the control, not an internal call.
  if (sw) sw.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  await sleep(2000);

  out.afterClick = {
    effectActive: !!item.system?.EffectActive,
    initiative: Number(actor.system?.initiativeImplantMod) || 0,
    markerTurns: (actor.getFlag("cp2020-augmented", "consumableState") ?? [])
      .filter(m => m.itemId === item.id).map(m => Number(m.turnsLeft) || 0),
    // The token mark: P7's display-only ActiveEffect, tagged with the item it belongs to.
    tokenMarks: (actor.effects?.contents ?? [])
      .filter(e => e.getFlag?.("cp2020-augmented", "consumableItemId") === item.id).length,
    // The table's card.
    cardCount: game.messages.contents.filter(m => !msgsBefore.has(m.id) && /Sandevistan/i.test(m.content ?? "")).length,
    // An un-rationed activation writes NO dose counter.
    storedDoses: Number(item._source?.system?.mechConsumable?.doses ?? -1),
  };
  // The card must not claim a ration it does not have.
  const card = game.messages.contents.filter(m => !msgsBefore.has(m.id) && /Sandevistan/i.test(m.content ?? "")).pop();
  out.afterClick.cardMentionsDoses = /doses left/i.test(card?.content ?? "");
  out.afterClick.cardMentionsDuration = /5 turn/i.test(card?.content ?? "");

  // The sheet re-renders on the item update: the control must now read as ON.
  await sleep(800);
  const root2 = actor.sheet.element instanceof HTMLElement ? actor.sheet.element : actor.sheet.element?.[0];
  const sw2 = root2?.querySelector(`.cp-cyber-switch[data-item-id="${item.id}"]`);
  out.switchOnAfter = !!sw2?.classList?.contains("is-on");
  out.switchTitleAfter = sw2?.getAttribute("title") ?? "";

  // ── The clock: real combat, real turns ───────────────────────────────────────────────────────
  await scene.activate();
  await sleep(500);
  const combat = await Combat.create({ scene: scene.id });
  out.combatId = combat.id;
  await combat.createEmbeddedDocuments("Combatant", [{ tokenId: tok.id, sceneId: scene.id, actorId: actor.id, initiative: 10 }]);
  await combat.startCombat();
  await sleep(1200);

  const turnsLeftNow = () => (actor.getFlag("cp2020-augmented", "consumableState") ?? [])
    .filter(m => m.itemId === item.id).map(m => Number(m.turnsLeft) || 0);

  out.afterStart = turnsLeftNow();
  out.perTurn = [];
  for (let i = 0; i < 4; i++) {
    await combat.nextTurn();
    await sleep(2000);
    out.perTurn.push(turnsLeftNow());
  }
  out.atFour = {
    markerTurns: turnsLeftNow(),
    effectActive: !!item.system?.EffectActive,
    initiative: Number(actor.system?.initiativeImplantMod) || 0,
  };

  const msgsBeforeExpiry = new Set(game.messages.contents.map(m => m.id));
  await combat.nextTurn();
  await sleep(2500);
  out.atFive = {
    markerTurns: turnsLeftNow(),
    effectActive: !!item.system?.EffectActive,
    initiative: Number(actor.system?.initiativeImplantMod) || 0,
    tokenMarks: (actor.effects?.contents ?? [])
      .filter(e => e.getFlag?.("cp2020-augmented", "consumableItemId") === item.id).length,
    expiryCards: game.messages.contents.filter(m => !msgsBeforeExpiry.has(m.id) && /Sandevistan/i.test(m.content ?? "")).length,
  };

  // ── i18n: every string this unit added resolves (a missing key echoes itself back) ───────────
  const KEYS = ["CyberSwitchOnTip", "CyberSwitchOffTip", "ConsumableUsedBodyUnlimited",
                "MechConsumableUnlimited", "MechConsumableUnlimitedHint", "CyberInstalledOff"];
  out.i18nUnresolved = KEYS.filter(k => {
    const full = `CYBERPUNK.${k}`;
    const v = game.i18n.localize(full);
    return !v || v === full || v === k;
  });

  // Teardown.
  await combat.delete().catch(() => {});
  for (const id of out.cleanup) await game.actors.get(id)?.delete().catch(() => {});
  for (const id of out.scenes) await game.scenes.get(id)?.delete().catch(() => {});
  return out;
});

await p.evaluate(async (ids) => {
  for (const id of ids) await game.actors.get(id)?.delete().catch(() => {});
}, r.cleanup);

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — got ${JSON.stringify(got)}${ok ? "" : `, want ${JSON.stringify(want)}`}`);
};

console.log("── F1 · the pack entry's own declaration ──");
eq("activated boost entry resolves", r.f1.sandeName, "Sandevistan Speedware");
eq("activated boost declares Activatable mode", r.f1.sandeMode, "Activatable");
eq("activated boost payload", r.f1.sandeInit, 3);
eq("activated boost ships switched off", r.f1.sandeStoredActive, false);
eq("always-on sibling declares Permanent mode", r.f1.kerenMode, "Permanent");
eq("always-on sibling payload", r.f1.kerenInit, 1);
eq("mechanism predicate selects the activated one", r.f1.sandeIsActivatedBoost, true);
eq("mechanism predicate rejects the always-on one", r.f1.kerenIsActivatedBoost, false);

console.log("── F2 · the contribution gate (negative beside positive) ──");
eq("switched off contributes nothing", r.f2.initOff, 0);
eq("switched on contributes its payload", r.f2.initOn, 3);
eq("switching back off drops it again", r.f2.initOffAgain, 0);

console.log("── F3 · the clock is read on, never written ──");
eq("prepared block is enabled", r.f3.preparedEnabled, true);
eq("prepared duration is the printed span", r.f3.preparedTurns, "5");
eq("prepared block is un-rationed", r.f3.preparedUnlimited, true);
eq("prepared note names the payload", r.f3.preparedNote, "+3 Initiative");
eq("STORED block untouched (enabled)", r.f3.storedEnabled, false);
eq("STORED block untouched (duration)", r.f3.storedTurns, "");
eq("always-on sibling gets no clock", r.f3.kerenGetsNoTimer, true);
eq("an item's own block is left alone", r.f3.respectsOwnBlock, true);

console.log("── F4 · one boost per character, both installation orders ──");
eq("activated-first · off", r.f4.aOff, 0);
eq("activated-first · on", r.f4.aOn, 3);
eq("always-on-first · dormant activated boost adds nothing", r.f4.bOff, 1);
eq("always-on-first · activating the surplus adds nothing", r.f4.bOn, 1);
eq("activated-first · dormant boost still holds the slot", r.f4.aSlotHolderWhileOff, "Sandevistan Speedware");
eq("always-on-first · the earlier install holds the slot", r.f4.bSlotHolderWhileOff, "Kerenzikov Boosterware I");
eq("no order drives the figure negative", r.f4.neverNegative, true);

console.log("── F5 · un-rationed use ──");
eq("reads as un-rationed", r.f5.unlimited, true);
eq("stored dose counter untouched", r.f5.storedDoses, 1);

console.log("── G1 · the real UI gesture ──");
eq("the row carries a switch", g.switchFound, true);
eq("switch reads OFF before the click", g.switchOnBefore, false);
eq("switch offers to activate", g.switchTitleBefore, "Activate this implant");
eq("the click activated the payload", g.afterClick.effectActive, true);
eq("the click delivered the initiative", g.afterClick.initiative, 3);
eq("the click started a 5-turn clock", g.afterClick.markerTurns, [5]);
eq("the click raised the token mark", g.afterClick.tokenMarks, 1);
eq("the click posted one card", g.afterClick.cardCount, 1);
eq("the card states the duration", g.afterClick.cardMentionsDuration, true);
eq("the card claims no ration", g.afterClick.cardMentionsDoses, false);
eq("activation wrote no dose counter", g.afterClick.storedDoses, 1);
eq("switch reads ON after the click", g.switchOnAfter, true);
eq("switch offers to switch off", g.switchTitleAfter, "Switch this implant off");

console.log("── G2 · it expires after exactly five turns ──");
eq("Begin Combat is not a turn elapsing", g.afterStart, [5]);
eq("countdown, one per owner turn", g.perTurn, [[4], [3], [2], [1]]);
eq("still running at four turns", g.atFour.markerTurns, [1]);
eq("payload still live at four turns", g.atFour.initiative, 3);
eq("clock gone at five turns", g.atFive.markerTurns, []);
eq("payload switched off with it", g.atFive.effectActive, false);
eq("initiative back to nothing", g.atFive.initiative, 0);
eq("token mark cleared", g.atFive.tokenMarks, 0);
eq("expiry posted its card", g.atFive.expiryCards, 1);

console.log("── G3 · strings ──");
eq("every added key resolves", g.i18nUnresolved, []);

eq("0 console errors", errors, []);
await b.close();
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
