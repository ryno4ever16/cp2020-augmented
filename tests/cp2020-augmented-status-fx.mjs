/**
 * KEEPER: persistent condition overlays (module/fx/status-fx.js).
 *
 * Covers, by value:
 *  - the PURE resolver: both detection roads (core condition id, module actor flag), the empty-marker
 *    negative, the suppression rule, table order, and an unrelated condition drawing nothing
 *  - the slot geometry: fixed per row id, distinct per family member, scaled by the figure's own width
 *  - the LIVE path on a real figure: a condition set draws the exact database key under the exact
 *    stamped name; the condition cleared takes it down again
 *  - the module-flag road driven through the real flag write, and its clear
 *  - the ruled ROUTING: every row — the four rings and the ground mark — is drawn BELOW the figures
 *    (reference-exact, user ruling 2026-08-12), asserted on the table and again on what the engine did
 *  - two conditions at once drawing two marks at two offsets
 *  - RELOAD: a full page reload with the condition still on redraws it (nothing is persisted)
 *  - figure deleted → its marks swept by name
 *  - the world switch off → nothing drawn, and the sweep takes down what was already there
 *  - no document is written: the scene's own effect flags stay empty throughout
 *  - the missing-key degrade, through the rail's existing database seam
 *  - TWO SESSIONS on one figure: one ring each, its own, and the delete clears both canvases
 *  - THE SCENE-LOAD WIPE RACE (§12): a marked figure survives a canvas round trip with no uncaught
 *    page error, the mark is still there afterwards, and the redraw is OBSERVED to happen after the
 *    engine's own after-wipe signal — plus a hand-driven control that puts the sweep back on the old
 *    canvasReady timing and shows the draw landing inside the wipe window instead
 *  - 0 console errors
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const eq = (n, got, want) => check(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
// The engine losing a race with itself while an effect is torn down mid-initialisation — already on
// record as a keeper trap (isolation-proven not ours; see the fx-rail spec's note on the same frame).
//
// ⚠ THE FILTER IS NOT A BLANKET PARDON ANY MORE. The module-side half of this frame — our sweep
// drawing into Sequencer's post-scene-load wipe — was closed on 2026-08-15 (status-fx.js now sweeps on
// `sequencerEffectManagerReady`), and §12 asserts the RAW count at zero across a scene round trip, this
// filter deliberately not applied. What stays pardoned here is the engine's residual window that no
// registration order on our side can close (an effect still loading when the canvas itself tears down),
// which §12's control section provokes on purpose.
const ENGINE_TEARDOWN_RACE = /Cannot set properties of null \(setting 'volume'\)/;
const engineRaces = [];
page.on("console", m => {
  if (m.type() !== "error" || /compatibility|deprecat|screen resolution/i.test(m.text())) return;
  errors.push(m.text());
});
page.on("pageerror", e => {
  const stack = String(e.stack ?? "").replace(/\s+/g, " ").slice(0, 300);
  if (ENGINE_TEARDOWN_RACE.test(e.message) && /_createSprite/.test(stack) && /sequencer/i.test(stack)) {
    engineRaces.push(stack.slice(0, 120)); return;
  }
  errors.push(e.message + " ||AT|| " + stack);
});

async function joinGM(p) {
  await p.goto(`${URL}/join`);
  await p.waitForSelector('select[name="userid"]');
  await p.evaluate(() => {
    const sel = document.querySelector('select[name="userid"]');
    sel.value = [...sel.options].find(o => /gamemaster/i.test(o.textContent)).value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await p.fill('input[name="password"]', PW);
  await p.click('button[name="join"]');
  await p.waitForFunction(() => window.game?.ready === true, null, { timeout: 60000 });
  await p.waitForTimeout(4000);
}

await joinGM(page);

const MOD = "/modules/cp2020-augmented/module/fx/status-fx.js";

/* ─────────────────── §1–2 the pure half ─────────────────── */
console.log("\n§1 detection resolver (pure)");
const pure = await page.evaluate(async (mod) => {
  const M = await import(mod);
  const r = (src) => M.statusMarkersOf(src);
  return {
    coreBurn:     r({ statuses: ["burning"] }),
    flagBurn:     r({ flags: { fireDotState: [{ turnsLeft: 2 }] } }),
    flagBurnNone: r({ flags: { fireDotState: [] } }),
    coreCorrode:  r({ statuses: ["corrode"] }),
    flagAcid:     r({ flags: { dotState: [{ location: "Torso" }] } }),
    poison:       r({ statuses: ["poison"] }),
    stunId:       r({ statuses: ["stun"] }),
    unconsciousId:r({ statuses: ["unconscious"] }),
    dead:         r({ statuses: ["dead"] }),
    suppressed:   r({ statuses: ["dead", "unconscious"] }),
    order:        r({ statuses: ["dead", "poison", "burning"] }),
    empty:        r({}),
    unrelated:    r({ statuses: ["prone", "blind", "fly"] }),
    rowIds:       M.STATUS_FX_ROWS.map(x => x.id),
    rowKeys:      M.STATUS_FX_ROWS.map(x => x.key),
    rowBelow:     M.STATUS_FX_ROWS.map(x => x.below === true),
    rowAbove:     M.STATUS_FX_ROWS.map(x => x.aboveLighting === false),
    namesFor:     M.statusFxNameFor("TOKENID", "burning"),
  };
}, MOD);
eq("core condition id raises its row", pure.coreBurn, ["burning"]);
eq("module flag with a live marker raises the same row", pure.flagBurn, ["burning"]);
eq("NEGATIVE: an empty marker list raises nothing", pure.flagBurnNone, []);
eq("core corrode raises the acid row", pure.coreCorrode, ["acid"]);
eq("module armour-degradation flag raises the acid row", pure.flagAcid, ["acid"]);
eq("poison id raises its row", pure.poison, ["poison"]);
eq("stun id raises the stunned row", pure.stunId, ["stunned"]);
eq("unconscious id raises the same stunned row", pure.unconsciousId, ["stunned"]);
eq("dead id raises its row", pure.dead, ["dead"]);
eq("suppression: dead cancels stunned", pure.suppressed, ["dead"]);
eq("output is in table order, not input order", pure.order, ["burning", "poison", "dead"]);
eq("NEGATIVE: nothing set raises nothing", pure.empty, []);
eq("NEGATIVE: unrelated core ids raise nothing", pure.unrelated, []);
eq("the shipped table is exactly five rows", pure.rowIds, ["burning", "poison", "acid", "stunned", "dead"]);
// The ring standard (user ruling 2026-08-12): every non-ground row rides the figure's rim.
eq("the shipped database keys", pure.rowKeys, [
  "jb2a.shield_themed.below.fire.01.orange",
  "jb2a.markers.smoke.ring.loop.bluepurple",
  "jb2a.shield_themed.below.molten_earth.01.orange",
  "jb2a.shield_themed.below.eldritch_web.01.dark_purple",
  "jb2a.markers.simple.001.loop.001.red",
]);
check("the stamped name encodes figure then row", pure.namesFor === "cp2020-augmented.statusfx.TOKENID.burning", pure.namesFor);
// ⭐ REFERENCE-EXACT, BELOW THE TOKEN (user ruling 2026-08-12). Every row — the four rings and the
// ground mark — declares `below: true` and `aboveLighting: false`. The table is asserted first because
// it is the one field the revert moves; §5b then reads what the engine actually did with it.
eq("every row is declared below-token", pure.rowBelow, [true, true, true, true, true]);
eq("and no row asks to be lifted above the lighting", pure.rowAbove, [true, true, true, true, true]);

console.log("\n§2 slot geometry (pure)");
const geo = await page.evaluate(async (mod) => {
  const M = await import(mod);
  return {
    poison1: M.statusFxOffset("poison", 1),
    stun1: M.statusFxOffset("stunned", 1),
    burn1: M.statusFxOffset("burning", 1),
    acid1: M.statusFxOffset("acid", 1),
    dead1: M.statusFxOffset("dead", 1),
    poison2: M.statusFxOffset("poison", 2),
    spec: { rise: M.STATUS_FX.badgeRise, spacing: M.STATUS_FX.badgeSpacing, spread: M.STATUS_FX.bodySpread, maxLive: M.STATUS_FX.maxLive, life: M.STATUS_FX.lifetimeMs },
  };
}, MOD);
// Ring rows stack CONCENTRICALLY — no slot offset for any of them, at any figure size; their
// differing rim scales (1.0 / 1.05 / 1.18 / 1.25) are what keep them visually apart.
eq("a ring row takes no slot offset (poison)", geo.poison1, { x: 0, y: 0 });
eq("a ring row takes no slot offset (stunned)", geo.stun1, { x: 0, y: 0 });
eq("a ring row takes no slot offset (burning)", geo.burn1, { x: 0, y: 0 });
eq("a ring row takes no slot offset (acid)", geo.acid1, { x: 0, y: 0 });
eq("a ground mark takes no offset", geo.dead1, { x: 0, y: 0 });
eq("figure size does not move a ring", geo.poison2, { x: 0, y: 0 });
eq("the spec block's own values", geo.spec, { rise: 0.3, spacing: 0.42, spread: 0.22, maxLive: 60, life: 600000 });

/* ─────────────────── fixtures ─────────────────── */
const fixture = await page.evaluate(async () => {
  const actor = await Actor.create({ name: "__PW__ConditionSubject", type: "character" });
  const proto = await actor.getTokenDocument({ x: 1000, y: 1000, actorLink: true });
  const [tokenDoc] = await canvas.scene.createEmbeddedDocuments("Token", [proto.toObject()]);
  return { actorId: actor.id, tokenId: tokenDoc.id, sceneId: canvas.scene.id, sceneName: canvas.scene.name };
});
console.log(`\n(fixture: figure ${fixture.tokenId} on "${fixture.sceneName}")`);

// ⚠ SCOPED TO THIS FIXTURE, ALWAYS. The rig carries real figures that legitimately wear a condition
// (a review target left holding fire markers by an earlier lane, a body marked out on another scene),
// and this rail draws for those too — correctly. A leg that counted every mark on the client would be
// asserting the rig's contents rather than this mechanism, so every census below is filtered to the
// figure this spec made.
//
// ⚠⚠ AND SCOPED TO THIS CLIENT'S OWN DRAWS (`creatorUserId`). That filter was added on 2026-08-13 to
// work around a defect — the draw went out through Sequencer's default push, so every connected
// client's rail broadcast its copy to every other one and a burning figure wore one ring per client on
// every screen. That is FIXED: the draw and the end are both local now (status-fx.js `drawStatusFx` /
// `endStatusFx`), and §11 below proves it with two real sessions. The filter STAYS anyway, because it
// is also what keeps these censuses honest about the rig's own standing figures, and because a foreign
// copy reappearing is exactly the regression worth catching — `foreign()` is reported at §3 and
// asserted at zero in §11. Each section declares the same two readers.

/* ─────────────────── §3 the live path, core condition ─────────────────── */
console.log("\n§3 live path — a core condition draws and clears");
const live1 = await page.evaluate(async ({ mod, actorId, TID }) => {
  const M = await import(mod);
  const own = () => M.liveStatusFx().filter(e => (e?.data?.creatorUserId ?? game.user.id) === game.user.id
                                             && String(e?.data?.name ?? "").includes(TID));
  const foreign = () => M.liveStatusFx().filter(e => (e?.data?.creatorUserId ?? game.user.id) !== game.user.id
                                                 && String(e?.data?.name ?? "").includes(TID)).length;
  const actor = game.actors.get(actorId);
  await actor.toggleStatusEffect("burning", { active: true });
  await new Promise(r => setTimeout(r, 2000));
  const drawn = own().map(e => e?.data?.name);
  const files = own().map(e => String(e?.data?.file ?? ""));
  const foreignCopies = foreign();
  const otherClients = game.users.filter(u => u.active && u.id !== game.user.id).map(u => u.name);
  await actor.toggleStatusEffect("burning", { active: false });
  await new Promise(r => setTimeout(r, 1500));
  return { drawn, files, foreignCopies, otherClients, after: own().map(e => e?.data?.name) };
}, { mod: MOD, actorId: fixture.actorId, TID: fixture.tokenId });
const burnName = `cp2020-augmented.statusfx.${fixture.tokenId}.burning`;
eq("condition set → exactly one mark, under the stamped name", live1.drawn, [burnName]);
eq("the drawn entry is the decoded rim-ring key", live1.files, ["jb2a.shield_themed.below.fire.01.orange"]);
eq("condition cleared → the mark is gone", live1.after, []);
// The standing report of who else was online while this ran. A foreign copy here would mean the local
// draw has regressed; §11 asserts it at zero with a second session deliberately opened.
console.log(`  (other clients signed in: ${live1.otherClients.length ? live1.otherClients.join(", ") : "none"}`
  + ` · foreign copies of this figure's mark: ${live1.foreignCopies})`);
check("no other client's copy of this figure's mark reached this canvas", live1.foreignCopies === 0, String(live1.foreignCopies));

/* ─────────────────── §4 the module-flag road ─────────────────── */
console.log("\n§4 live path — the module's own lasting-damage flag");
const live2 = await page.evaluate(async ({ mod, actorId, TID }) => {
  const M = await import(mod);
  const own = () => M.liveStatusFx().filter(e => (e?.data?.creatorUserId ?? game.user.id) === game.user.id
                                             && String(e?.data?.name ?? "").includes(TID));
  const actor = game.actors.get(actorId);
  await actor.setFlag("cp2020-augmented", "dotState", [{ location: "Torso", turnsLeft: 3 }]);
  await new Promise(r => setTimeout(r, 2000));
  const drawn = own().map(e => e?.data?.name);
  const files = own().map(e => String(e?.data?.file ?? ""));
  await actor.unsetFlag("cp2020-augmented", "dotState");
  await new Promise(r => setTimeout(r, 1500));
  return { drawn, files, after: own().map(e => e?.data?.name) };
}, { mod: MOD, actorId: fixture.actorId, TID: fixture.tokenId });
eq("armour-degradation flag written → the acid mark appears", live2.drawn,
  [`cp2020-augmented.statusfx.${fixture.tokenId}.acid`]);
eq("the drawn entry is the recoloured molten-ring key", live2.files, ["jb2a.shield_themed.below.molten_earth.01.orange"]);
eq("flag cleared → the mark is gone", live2.after, []);

/* ─────────────────── §4b the flag raises core's own condition ─────────────────── */
// ⭐ THE DEFECT THIS SECTION PINS (user report): a figure set on fire wore the ring and had NOTHING in
// its Active Effects, because the lasting-damage engines wrote their own flag and nobody ever toggled
// core's `burning`. The ring was drawn off the FLAG road, so the picture looked right while the token
// HUD, the effects list and anything else reading `actor.statuses` disagreed with it. The engines now
// mirror the flag onto the core condition on the way in and take it off when the last marker expires,
// which is the whole of this section — driven through the REAL apply helpers and the REAL per-turn
// tick, never by setting a status by hand.
//
// ⚠ The tick belongs to an encounter, so this section brings its OWN (created inactive and deleted on
// the way out): the rig's showcase encounter is the user's and is never touched. The round-tick master
// is pinned for the same reason a rider setting is, and restored in the finally.
console.log("\n§4b the lasting-damage flags mirror onto core's own conditions");
const mirror = await page.evaluate(async ({ actorId, tokenId }) => {
  const saves = await import("/modules/cp2020-augmented/module/combat/save-rolls.js");
  const M = await import("/modules/cp2020-augmented/module/fx/status-fx.js");
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const SCOPE = "cp2020-augmented";
  const actor = game.actors.get(actorId);
  // ⚠ THE RACE THIS MIRROR COULD HAVE OPENED, asked about directly. One apply now raises TWO document
  // events on the same figure — the flag write (updateActor) and the status toggle (createActiveEffect)
  // — and the overlay reconciler answers both. If it cannot see its own in-flight draw, both passes
  // find the mark missing and the figure ends up wearing two of them. Counted on THIS client's own
  // creations, for the reason the header gives.
  const ownMarks = () => M.liveStatusFx()
    .filter(e => (e?.data?.creatorUserId ?? game.user.id) === game.user.id
              && String(e?.data?.name ?? "").includes(tokenId)).length;
  const out = { activeGM: game.users.activeGM?.name ?? null, isSelfActiveGM: game.users.activeGM?.id === game.user.id };
  const statusesNow = () => [...(actor.statuses ?? [])];
  const effectStatuses = () => actor.effects.map(e => [...(e.statuses ?? [])]).flat();
  const tickWas = game.settings.get(SCOPE, "mechRoundTickAutomation");
  const fireWas = game.settings.get(SCOPE, "fireDotEnabled");
  const acidWas = game.settings.get(SCOPE, "acidArmorDotEnabled");
  let combat = null;
  try {
    await game.settings.set(SCOPE, "mechRoundTickAutomation", true);
    await game.settings.set(SCOPE, "fireDotEnabled", true);
    await game.settings.set(SCOPE, "acidArmorDotEnabled", true);

    /* §4b-i — a fire DoT applied through the real helper raises `burning` */
    await saves.applyFireDotState(actor, "Torso", 2, "1d6");
    await sleep(1200);
    out.afterFireApply = { statuses: statusesNow(), effects: effectStatuses(),
                           flag: (actor.getFlag(SCOPE, "fireDotState") ?? []).length,
                           marks: ownMarks() };

    /* §4b-ii — an acid DoT likewise raises `corrode`, beside the burn rather than instead of it */
    await saves.applyAcidDotState(actor, "Torso", 1, "1d6");
    await sleep(1200);
    out.afterAcidApply = { statuses: statusesNow(), flag: (actor.getFlag(SCOPE, "dotState") ?? []).length };

    /* §4b-iii — ONE tick: the burn has 2 turns, so it survives with its status; the acid had 1 and goes */
    combat = await Combat.create({ scene: canvas.scene.id, active: false });
    await combat.createEmbeddedDocuments("Combatant", [{ tokenId, actorId, sceneId: canvas.scene.id }]);
    await combat.update({ round: 1, turn: 0 });
    await sleep(800);
    await combat.update({ round: 2, turn: 0 });     // previous.round = 1 → the over-time tick runs
    await sleep(6000);
    out.afterFirstTick = {
      statuses: statusesNow(),
      fire: (actor.getFlag(SCOPE, "fireDotState") ?? []).length,
      acid: (actor.getFlag(SCOPE, "dotState") ?? []).length,
    };

    /* §4b-iv — a second tick empties the burn, and the status goes with the last marker */
    await combat.update({ round: 3, turn: 0 });
    await sleep(6000);
    out.afterSecondTick = {
      statuses: statusesNow(),
      fire: (actor.getFlag(SCOPE, "fireDotState") ?? []).length,
      effects: effectStatuses(),
    };
  } finally {
    if (combat) await combat.delete().catch(() => {});
    await game.settings.set(SCOPE, "mechRoundTickAutomation", tickWas);
    await game.settings.set(SCOPE, "fireDotEnabled", fireWas);
    await game.settings.set(SCOPE, "acidArmorDotEnabled", acidWas);
    await actor.unsetFlag(SCOPE, "fireDotState").catch(() => {});
    await actor.unsetFlag(SCOPE, "dotState").catch(() => {});
    for (const id of ["burning", "corrode"]) {
      if (actor.statuses?.has?.(id)) await actor.toggleStatusEffect(id, { active: false }).catch(() => {});
    }
    await sleep(1500);
    out.restored = { statuses: statusesNow(), tick: game.settings.get(SCOPE, "mechRoundTickAutomation") };
  }
  return out;
}, { actorId: fixture.actorId, tokenId: fixture.tokenId });
console.log(`  (active GM for the tick: ${mirror.activeGM}${mirror.isSelfActiveGM ? " — this client" : " — ANOTHER client"})`);
check("a fire DoT applied through the engine raises core's `burning`",
  mirror.afterFireApply.statuses.includes("burning"), JSON.stringify(mirror.afterFireApply));
check("and it is a real ActiveEffect carrying that status, not just a derived set",
  mirror.afterFireApply.effects.includes("burning"), JSON.stringify(mirror.afterFireApply.effects));
check("the burn's own marker was written beside it, by value",
  mirror.afterFireApply.flag === 1, String(mirror.afterFireApply.flag));
check("and the two events one apply raises still draw ONE mark, not two (the reconciler sees its own in-flight draw)",
  mirror.afterFireApply.marks === 1, `${mirror.afterFireApply.marks} marks`);
check("an acid DoT raises `corrode` and leaves the burn's status standing",
  mirror.afterAcidApply.statuses.includes("corrode") && mirror.afterAcidApply.statuses.includes("burning"),
  JSON.stringify(mirror.afterAcidApply));
check("one tick: the 2-turn burn survives and KEEPS its status (negative on an early clear)",
  mirror.afterFirstTick.fire === 1 && mirror.afterFirstTick.statuses.includes("burning"),
  JSON.stringify(mirror.afterFirstTick));
check("the same tick emptied the 1-turn acid, and `corrode` went with the last marker",
  mirror.afterFirstTick.acid === 0 && !mirror.afterFirstTick.statuses.includes("corrode"),
  JSON.stringify(mirror.afterFirstTick));
check("a second tick empties the burn, and `burning` goes with its last marker",
  mirror.afterSecondTick.fire === 0 && !mirror.afterSecondTick.statuses.includes("burning"),
  JSON.stringify(mirror.afterSecondTick));
check("no ActiveEffect is left carrying either condition",
  !mirror.afterSecondTick.effects.includes("burning") && !mirror.afterSecondTick.effects.includes("corrode"),
  JSON.stringify(mirror.afterSecondTick.effects));
check("the section left the figure clean and the round-tick master where it found it",
  mirror.restored.statuses.length === 0 && typeof mirror.restored.tick === "boolean",
  JSON.stringify(mirror.restored));

/* ─────────────────── §5 stacking ─────────────────── */
console.log("\n§5 two conditions at once");
const stack = await page.evaluate(async ({ mod, actorId, TID }) => {
  const M = await import(mod);
  const own = () => M.liveStatusFx().filter(e => (e?.data?.creatorUserId ?? game.user.id) === game.user.id
                                             && String(e?.data?.name ?? "").includes(TID));
  const actor = game.actors.get(actorId);
  await actor.toggleStatusEffect("burning", { active: true });
  await actor.toggleStatusEffect("poison", { active: true });
  await new Promise(r => setTimeout(r, 2500));
  const eff = own();
  const out = {
    names: eff.map(e => e?.data?.name).sort(),
    offsets: eff.map(e => ({ n: String(e?.data?.name ?? "").split(".").pop(), x: e?.data?.spriteOffset?.x ?? null })),
    // `sortLayer` 600 is where Sequencer records belowTokens — read here so the two rings drawn at once
    // are both proven to be under the mini, not just the one §5b grabs on its own.
    layers: eff.map(e => ({ n: String(e?.data?.name ?? "").split(".").pop(), layer: e?.data?.sortLayer ?? null })),
    sceneFlagKeys: Object.keys(canvas.scene.flags?.sequencer ?? {}).length,
  };
  await actor.toggleStatusEffect("burning", { active: false });
  await actor.toggleStatusEffect("poison", { active: false });
  await new Promise(r => setTimeout(r, 1500));
  out.after = own().length;
  return out;
}, { mod: MOD, actorId: fixture.actorId, TID: fixture.tokenId });
eq("both marks are drawn, one per condition", stack.names, [
  `cp2020-augmented.statusfx.${fixture.tokenId}.burning`,
  `cp2020-augmented.statusfx.${fixture.tokenId}.poison`,
].sort());
const offX = Object.fromEntries(stack.offsets.map(o => [o.n, o.x]));
// Rings are concentric by design: neither mark takes a sprite offset (their rim scales differ instead).
check("ring marks stack concentrically — neither takes a slot offset",
  (offX.burning === null || offX.burning === 0) && (offX.poison === null || offX.poison === 0),
  JSON.stringify(offX));
const layerOf = Object.fromEntries(stack.layers.map(o => [o.n, o.layer]));
check("both rings are drawn UNDER the figure, by value", layerOf.burning === 600 && layerOf.poison === 600,
  JSON.stringify(layerOf));
check("no document was written: the scene carries no effect flags", stack.sceneFlagKeys === 0, String(stack.sceneFlagKeys));
check("both cleared → nothing left", stack.after === 0, String(stack.after));

/* ─────────────────── §5b every row's routing, and the recolour ─────────────────── */
console.log("\n§5b the below-token routing and the recolour");
const branches = await page.evaluate(async ({ mod, actorId, TID }) => {
  const M = await import(mod);
  const own = () => M.liveStatusFx().filter(e => (e?.data?.creatorUserId ?? game.user.id) === game.user.id
                                             && String(e?.data?.name ?? "").includes(TID));
  const actor = game.actors.get(actorId);
  const grab = (id) => {
    const e = own().find(x => String(x?.data?.name ?? "") === `cp2020-augmented.statusfx.${TID}.${id}`);
    // `sortLayer` is where Sequencer records belowTokens (600); `aboveLighting` is the other routing.
    return e ? { file: String(e.data.file ?? ""), sortLayer: e.data.sortLayer ?? null,
                 aboveLighting: e.data.aboveLighting ?? null,
                 filters: JSON.stringify(e.data.filters ?? e.data.filter ?? null).slice(0, 200) } : null;
  };
  const out = {};
  // A ring row: since the reference-exact ruling it takes the SAME below-tokens branch the ground row
  // does, so the two readings below are a match rather than a contrast.
  await actor.toggleStatusEffect("burning", { active: true });
  await new Promise(r => setTimeout(r, 2000));
  out.burning = grab("burning");
  await actor.toggleStatusEffect("burning", { active: false });
  await new Promise(r => setTimeout(r, 1200));
  // The stunned ring, so all four rings are read live somewhere in this spec rather than only in the table.
  await actor.toggleStatusEffect("stun", { active: true });
  await new Promise(r => setTimeout(r, 2000));
  out.stunned = grab("stunned");
  await actor.toggleStatusEffect("stun", { active: false });
  await new Promise(r => setTimeout(r, 1200));
  // The ground row, which took this branch before every other row joined it.
  await actor.toggleStatusEffect("dead", { active: true });
  await new Promise(r => setTimeout(r, 2000));
  out.dead = grab("dead");
  out.deadNames = own().map(e => e?.data?.name);
  await actor.toggleStatusEffect("dead", { active: false });
  await new Promise(r => setTimeout(r, 1200));
  // The recoloured row, which is the only one taking the filter branch.
  await actor.setFlag("cp2020-augmented", "dotState", [{ location: "Torso", turnsLeft: 1 }]);
  await new Promise(r => setTimeout(r, 2000));
  out.acid = grab("acid");
  await actor.unsetFlag("cp2020-augmented", "dotState");
  await new Promise(r => setTimeout(r, 1200));
  out.after = own().length;
  return out;
}, { mod: MOD, actorId: fixture.actorId, TID: fixture.tokenId });
eq("the ground row draws exactly one mark, and the stunned row is not raised with it",
  branches.deadNames, [`cp2020-augmented.statusfx.${fixture.tokenId}.dead`]);
check("the ground row carries the simple-marker loop key",
  branches.dead?.file === "jb2a.markers.simple.001.loop.001.red", JSON.stringify(branches.dead));
check("the ground row is routed below the figures", branches.dead?.sortLayer === 600,
  `sortLayer ${branches.dead?.sortLayer}`);
// ⭐ THE RULED ROUTING (2026-08-12, reference-exact): the rings go under the mini exactly as the ground
// mark does. Below the tokens is below the LIGHTING — the accepted trade — so the negative beside it is
// that no row asks for the lighting lift any more.
check("a ring row is routed below the figures too, by value", branches.burning?.sortLayer === 600,
  `burning sortLayer ${branches.burning?.sortLayer}`);
check("the stunned ring likewise", branches.stunned?.sortLayer === 600,
  `stunned sortLayer ${branches.stunned?.sortLayer}`);
check("the recoloured acid ring likewise", branches.acid?.sortLayer === 600,
  `acid sortLayer ${branches.acid?.sortLayer}`);
check("NEGATIVE: no row is lifted above the lighting any more",
  branches.burning?.aboveLighting !== true && branches.stunned?.aboveLighting !== true
  && branches.acid?.aboveLighting !== true && branches.dead?.aboveLighting !== true,
  `burning ${branches.burning?.aboveLighting} stunned ${branches.stunned?.aboveLighting} acid ${branches.acid?.aboveLighting} dead ${branches.dead?.aboveLighting}`);
check("the recoloured row carries a colour matrix",
  /ColorMatrix/i.test(branches.acid?.filters ?? ""), String(branches.acid?.filters));
check("both branches cleared", branches.after === 0, String(branches.after));

/* ─────────────────── §6 reload ─────────────────── */
console.log("\n§6 reload — the mark is rebuilt from the condition, not restored");
await page.evaluate(async ({ actorId }) => {
  await game.actors.get(actorId).toggleStatusEffect("burning", { active: true });
  await new Promise(r => setTimeout(r, 1500));
}, { actorId: fixture.actorId });
const flagsBeforeReload = await page.evaluate(() => Object.keys(canvas.scene.flags?.sequencer ?? {}).length);
await joinGM(page);
await page.waitForTimeout(4000);
const afterReload = await page.evaluate(async ({ mod, actorId, TID }) => {
  const M = await import(mod);
  const own = () => M.liveStatusFx().filter(e => (e?.data?.creatorUserId ?? game.user.id) === game.user.id
                                             && String(e?.data?.name ?? "").includes(TID));
  const out = { drawn: own().map(e => e?.data?.name) };
  await game.actors.get(actorId).toggleStatusEffect("burning", { active: false });
  await new Promise(r => setTimeout(r, 1500));
  out.after = own().length;
  return out;
}, { mod: MOD, actorId: fixture.actorId, TID: fixture.tokenId });
check("nothing was persisted into the scene before the reload", flagsBeforeReload === 0, String(flagsBeforeReload));
eq("after a full reload the mark is drawn again", afterReload.drawn, [burnName]);
check("and it still clears with the condition", afterReload.after === 0, String(afterReload.after));

/* ─────────────────── §7 the world switch ─────────────────── */
console.log("\n§7 the world switch");
const sw = await page.evaluate(async ({ mod, actorId, TID }) => {
  const M = await import(mod);
  const own = () => M.liveStatusFx().filter(e => (e?.data?.creatorUserId ?? game.user.id) === game.user.id
                                             && String(e?.data?.name ?? "").includes(TID));
  const actor = game.actors.get(actorId);
  const prior = game.settings.get("cp2020-augmented", "combatFxEnabled");
  const out = {};
  try {
    await actor.toggleStatusEffect("burning", { active: true });
    await new Promise(r => setTimeout(r, 1800));
    out.onCount = own().length;
    await game.settings.set("cp2020-augmented", "combatFxEnabled", false);
    // The switch is read per event, so the sweep is what a next event would do.
    M.syncSceneStatusFx();
    await new Promise(r => setTimeout(r, 1500));
    out.sweptCount = own().length;
    await actor.toggleStatusEffect("burning", { active: false });
    await actor.toggleStatusEffect("poison", { active: true });
    await new Promise(r => setTimeout(r, 1800));
    out.offCount = own().length;
  } finally {
    await game.settings.set("cp2020-augmented", "combatFxEnabled", prior);
    await actor.toggleStatusEffect("poison", { active: false }).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    out.restored = game.settings.get("cp2020-augmented", "combatFxEnabled");
    out.finalCount = own().length;
  }
  return out;
}, { mod: MOD, actorId: fixture.actorId, TID: fixture.tokenId });
check("switch on → the mark is drawn", sw.onCount === 1, String(sw.onCount));
check("switch off → the sweep takes down what was there", sw.sweptCount === 0, String(sw.sweptCount));
check("NEGATIVE: with the switch off a new condition draws nothing", sw.offCount === 0, String(sw.offCount));
check("the setting was restored", sw.restored === true, String(sw.restored));
check("nothing left behind", sw.finalCount === 0, String(sw.finalCount));

/* ─────────────────── §8 missing key degrade ─────────────────── */
console.log("\n§8 an asset tier without the key");
const degrade = await page.evaluate(async ({ mod, actorId, TID }) => {
  const M = await import(mod);
  const own = () => M.liveStatusFx().filter(e => (e?.data?.creatorUserId ?? game.user.id) === game.user.id
                                             && String(e?.data?.name ?? "").includes(TID));
  const FX = await import("/modules/cp2020-augmented/module/fx/effects.js");
  const actor = game.actors.get(actorId);
  const out = {};
  try {
    FX._setDbProbe(() => false);
    await actor.toggleStatusEffect("burning", { active: true });
    await new Promise(r => setTimeout(r, 1500));
    out.drawn = own().length;
  } finally {
    FX._setDbProbe(null);
    await actor.toggleStatusEffect("burning", { active: false }).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    out.after = own().length;
  }
  return out;
}, { mod: MOD, actorId: fixture.actorId, TID: fixture.tokenId });
check("NEGATIVE: a key the installed tier lacks is skipped, not played", degrade.drawn === 0, String(degrade.drawn));
check("and the seam restored cleanly", degrade.after === 0, String(degrade.after));

/* ─────────────────── §9 figure deleted ─────────────────── */
// This section used to be RED whenever a second client was signed in, and the failure was the broadcast
// defect rather than this sweep: two clients drew two effects under the SAME stamped name, the sweep
// ended that name once and registered ONE intent, and the engine reported TWO ends — the second read as
// an expiry and the mark was drawn again, so with two GMs online deleting a burning figure could leave
// a ring behind. Both halves are local now, so one client's sweep ends exactly what that client drew.
// §11 runs the same delete with a second session actually open.
console.log("\n§9 the figure is deleted while wearing a mark");
const del = await page.evaluate(async ({ mod, actorId, tokenId, TID }) => {
  const M = await import(mod);
  const own = () => M.liveStatusFx().filter(e => (e?.data?.creatorUserId ?? game.user.id) === game.user.id
                                             && String(e?.data?.name ?? "").includes(TID));
  const actor = game.actors.get(actorId);
  await actor.toggleStatusEffect("burning", { active: true });
  await new Promise(r => setTimeout(r, 1800));
  const before = own().length;
  await canvas.scene.deleteEmbeddedDocuments("Token", [tokenId]);
  await new Promise(r => setTimeout(r, 1800));
  return {
    before, after: own().length,
    others: game.users.filter(u => u.active && u.id !== game.user.id).length,
  };
}, { mod: MOD, actorId: fixture.actorId, tokenId: fixture.tokenId, TID: fixture.tokenId });
check("the mark was up before the delete", del.before === 1, String(del.before));
check("the figure's marks are swept by name when it goes", del.after === 0,
  `${del.after} left`
  + (del.after && del.others ? ` — ${del.others} other client(s) signed in; the duplicate-name end re-issues (broadcast defect, §8)` : ""));

/* ─────────────────── §11 two sessions, one figure ─────────────────── */
// THE POINT OF THE WHOLE LOCALITY RULING, counted rather than argued: with two sessions signed in and
// looking at the same figure, each canvas must hold exactly ONE ring for it — its own — and deleting
// the figure must leave ZERO on both. The failure this replaces was two-sided: a broadcast draw put a
// second ring on each screen, and a broadcast end let one client's sweep cancel the other's while the
// other read the cancellation as an expiry and drew the mark back.
console.log("\n§11 two sessions — one mark each, and the delete clears both");
const second = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const secondErrors = [];
second.on("pageerror", e => {
  const stack = String(e.stack ?? "").replace(/\s+/g, " ").slice(0, 300);
  if (ENGINE_TEARDOWN_RACE.test(e.message) && /_createSprite/.test(stack) && /sequencer/i.test(stack)) return;
  secondErrors.push(e.message);
});

// A second seat at the table. Role 4 = gamemaster, no password, deleted at the end of the section.
const gm2 = await page.evaluate(async () => {
  for (const u of game.users.filter(u => u.name === "__PW__GM2")) await u.delete().catch(() => {});
  const u = await User.create({ name: "__PW__GM2", role: CONST.USER_ROLES.GAMEMASTER });
  return { id: u.id, name: u.name };
});

async function joinAs(p, name) {
  await p.goto(`${URL}/join`);
  await p.waitForSelector('select[name="userid"]');
  await p.evaluate((n) => {
    const sel = document.querySelector('select[name="userid"]');
    sel.value = [...sel.options].find(o => o.textContent.trim() === n).value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, name);
  await p.click('button[name="join"]');
  await p.waitForFunction(() => window.game?.ready === true, null, { timeout: 60000 });
  await p.waitForTimeout(6000);   // past sequencerReady, whose catch-up sweep is what draws on arrival
}
await joinAs(second, gm2.name);

// Both sessions must be looking at the same scene for either to draw.
const twoFixture = await page.evaluate(async () => {
  for (const a of game.actors.filter(a => a.name === "__PW__TwoClientSubject")) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__TwoClientSubject", type: "character" });
  const proto = await actor.getTokenDocument({ x: 1400, y: 1000, actorLink: true });
  const [tokenDoc] = await canvas.scene.createEmbeddedDocuments("Token", [proto.toObject()]);
  return { actorId: actor.id, tokenId: tokenDoc.id, sceneId: canvas.scene.id };
});
await second.evaluate(async ({ sceneId }) => {
  if (game.user.viewedScene !== sceneId) await game.scenes.get(sceneId)?.view();
  await new Promise(r => setTimeout(r, 2500));
}, { sceneId: twoFixture.sceneId });

const census = (p, TID) => p.evaluate(async ({ mod, TID }) => {
  const M = await import(mod);
  const all = M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID));
  return {
    total: all.length,
    own: all.filter(e => (e?.data?.creatorUserId ?? game.user.id) === game.user.id).length,
    foreign: all.filter(e => (e?.data?.creatorUserId ?? game.user.id) !== game.user.id).length,
    names: all.map(e => String(e?.data?.name ?? "")),
  };
}, { mod: MOD, TID });

await page.evaluate(async ({ actorId }) => {
  await game.actors.get(actorId).toggleStatusEffect("burning", { active: true });
  await new Promise(r => setTimeout(r, 2500));
}, { actorId: twoFixture.actorId });
await second.waitForTimeout(2500);

const c1 = await census(page, twoFixture.tokenId);
const c2 = await census(second, twoFixture.tokenId);
check("session 1 holds exactly one ring for the figure", c1.total === 1, `${c1.total} (own ${c1.own}, foreign ${c1.foreign})`);
check("session 2 holds exactly one ring for the figure", c2.total === 1, `${c2.total} (own ${c2.own}, foreign ${c2.foreign})`);
check("session 1's ring is its own creation", c1.own === 1 && c1.foreign === 0, `own ${c1.own} foreign ${c1.foreign}`);
check("session 2's ring is its own creation", c2.own === 1 && c2.foreign === 0, `own ${c2.own} foreign ${c2.foreign}`);
eq("both sessions stamp the same name", [...new Set([...c1.names, ...c2.names])],
  [`cp2020-augmented.statusfx.${twoFixture.tokenId}.burning`]);

await page.evaluate(async ({ tokenId }) => {
  await canvas.scene.deleteEmbeddedDocuments("Token", [tokenId]);
  await new Promise(r => setTimeout(r, 3000));
}, { tokenId: twoFixture.tokenId });
await second.waitForTimeout(3000);

const d1 = await census(page, twoFixture.tokenId);
const d2 = await census(second, twoFixture.tokenId);
check("deleting the figure leaves nothing on session 1", d1.total === 0, `${d1.total} left: ${d1.names.join(",")}`);
check("deleting the figure leaves nothing on session 2", d2.total === 0, `${d2.total} left: ${d2.names.join(",")}`);
check("0 console errors on the second session", secondErrors.length === 0, secondErrors.slice(0, 3).join(" | "));

await second.close();
await page.evaluate(async ({ actorId, userId }) => {
  try { await game.actors.get(actorId)?.delete(); } catch (_e) { /* already gone */ }
  try { await game.users.get(userId)?.delete(); } catch (_e) { /* already gone */ }
}, { actorId: twoFixture.actorId, userId: gm2.id });

/* ─────────────────── §12 the scene-load wipe race ─────────────────── */
// ⭐⭐ THE DEFECT THIS SECTION PINS (measured 2026-08-15, import-staging/AUDIO-PAGEERROR-DIAGNOSIS.md).
// On EVERY scene load Sequencer's own debounced setup runs `initializePersistentEffects →
// tearDownPersistentEffects`, which destroys every live effect on the client — armed as early as
// canvasReady+241 ms on this rig. The sweep used to ride `canvasReady` directly, so it drew the rings
// INTO that window: a ring still inside its ~860 ms asset load when the wipe landed was destroyed
// mid-`activate`, and the engine rethrew out of its own unheld `_initialize` promise as an uncaught
// "Cannot set properties of null (setting 'volume')". The console noise was the lesser half — the mark
// was also SILENTLY EATEN (the destroy is not reported through `endedSequencerEffect`, so nothing
// re-issued it) and the figure went unmarked for the rest of the session.
//
// RED SIDE ON RECORD, not re-created here: the diagnosis reproduced the uncaught error on 4 of 4
// consecutive walkthrough runs against the unfixed tree, plus twice more from a standalone probe that
// did nothing but a scene round trip on a world holding one marked figure (its §4 "Minimal
// reproduction"). §12b below drives the OLD timing by hand — without touching the source — so the
// ordering difference is proven inside this spec rather than only cited.
//
// The three readings this section takes, in the diagnosis's own terms:
//   (a) not one uncaught page error across the round trip — the raw count, ENGINE_TEARDOWN_RACE
//       filter deliberately NOT applied
//   (b) the mark is still on the figure after the return, read back by its stamped name
//   (c) the ordering BY OBSERVATION: the redraw was issued after the engine's after-wipe signal fired
//       for that load, not before it — hook timestamps recorded inside the page
console.log("\n§12 a canvas round trip on a marked figure — the wipe race");
const errBase = errors.length, raceBase = engineRaces.length;

const wipeSetup = await page.evaluate(async ({ mod }) => {
  const M = await import(mod);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // Hook-timestamp instrumentation. Recording only — nothing here holds a promise or changes an
  // ordering, which matters because merely attaching a handler to the engine's detached
  // `_initialize()` promise is enough to make the race stop presenting (diagnosis §1).
  const t0 = performance.now();
  const marks = [];
  const rec = (label, detail) => marks.push({ t: Math.round(performance.now() - t0), label, detail: detail ?? null });
  const ids = {
    canvasReady:  Hooks.on("canvasReady", () => rec("canvasReady", canvas?.scene?.name ?? null)),
    managerReady: Hooks.on("sequencerEffectManagerReady", () => rec("managerReady")),
    created:      Hooks.on("createSequencerEffect", (e) => rec("effectIssued", String(e?.data?.name ?? ""))),
    ended:        Hooks.on("endedSequencerEffect", (e) => rec("effectEnded", String(e?.data?.name ?? ""))),
  };
  window.__PW_WIPE = { marks, rec, ids };

  for (const a of game.actors.filter(a => a.name === "__PW__WipeRaceSubject")) await a.delete().catch(() => {});
  for (const s of game.scenes.filter(s => s.name === "__PW__WipeRaceScene")) await s.delete().catch(() => {});
  const home = canvas.scene;
  const actor = await Actor.create({ name: "__PW__WipeRaceSubject", type: "character" });
  const proto = await actor.getTokenDocument({ x: 1200, y: 1400, actorLink: true });
  const [tokenDoc] = await home.createEmbeddedDocuments("Token", [proto.toObject()]);
  // The ground mark, which is the exact row the diagnosis caught being destroyed mid-load.
  await actor.toggleStatusEffect("dead", { active: true });
  await sleep(2500);
  const name = M.statusFxNameFor(tokenDoc.id, "dead");
  const up = M.liveStatusFx().filter(e => String(e?.data?.name ?? "") === name).length;

  const away = await Scene.create({ name: "__PW__WipeRaceScene", width: 2000, height: 2000, grid: { size: 100 } });
  return { actorId: actor.id, tokenId: tokenDoc.id, homeId: home.id, homeName: home.name, awayId: away.id, name, up };
}, { mod: MOD });
console.log(`  (fixture: figure ${wipeSetup.tokenId} marked on "${wipeSetup.homeName}", scratch canvas __PW__WipeRaceScene)`);
check("the ground mark is up before the round trip", wipeSetup.up === 1, `${wipeSetup.up} drawn`);

// ── §12a the shipped ordering ──
// A CLIENT-LOCAL scene switch (`view`), not `activate`: it raises the same
// canvasTearDown → canvasInit → canvasReady cycle that arms Sequencer's setup — which is the whole
// mechanism — while leaving the world's active scene where the rig had it.
const roundTrip = await page.evaluate(async ({ mod, homeId, awayId, name }) => {
  const M = await import(mod);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const W = window.__PW_WIPE;
  W.rec("MARK switch away");
  await game.scenes.get(awayId).view();
  await sleep(5000);
  W.rec("MARK switch back");
  const from = W.marks.length;
  await game.scenes.get(homeId).view();
  await sleep(9000);
  return {
    from,
    marks: W.marks.slice(),
    present: M.liveStatusFx().filter(e => String(e?.data?.name ?? "") === name).length,
    onHome: canvas.scene.id === homeId,
  };
}, { mod: MOD, homeId: wipeSetup.homeId, awayId: wipeSetup.awayId, name: wipeSetup.name });
await page.waitForTimeout(2000);
const err12a = errors.length - errBase, race12a = engineRaces.length - raceBase;

// (a) — the raw count, both buckets, because the filtered bucket is exactly the frame under test.
check("ZERO uncaught page errors across the round trip (raw count, the engine-teardown frame included)",
  err12a === 0 && race12a === 0, `${err12a} unfiltered + ${race12a} teardown-frame`);
// (b) — the mark itself, which is the half a console filter would have hidden.
check("the figure is still wearing its mark after the return, under the stamped name",
  roundTrip.present === 1 && roundTrip.onHome, `${roundTrip.present} drawn (on home canvas: ${roundTrip.onHome})`);

// (c) — the ordering, read off the recorded hooks for the RETURN load only.
const seg = roundTrip.marks.slice(roundTrip.from);
const iCR   = seg.findIndex(m => m.label === "canvasReady");
const iMR   = seg.findIndex((m, i) => m.label === "managerReady" && i > iCR);
const iDraw = seg.findIndex((m, i) => m.label === "effectIssued" && m.detail === wipeSetup.name && i > iCR);
console.log("  (return load, recorded: " + seg.filter(m => m.label !== "effectIssued" || m.detail === wipeSetup.name)
  .map(m => `${m.t}ms ${m.label}${m.detail && m.label === "canvasReady" ? ` ${m.detail}` : ""}`).join(" → ") + ")");
check("the return load raised the engine's own after-wipe signal", iCR >= 0 && iMR > iCR,
  `canvasReady@${iCR} managerReady@${iMR}`);
check("and the mark's redraw was issued AFTER that signal, not into the wipe window",
  iDraw > iMR && iMR >= 0, iDraw < 0 ? "no redraw recorded for this mark" : `signal@${seg[iMR]?.t}ms redraw@${seg[iDraw]?.t}ms`);
// The negative beside it: nothing was issued for this mark in the canvasReady→signal gap, which is
// precisely where the old registration put it.
check("NEGATIVE: nothing was issued for this mark between canvas ready and the signal",
  !seg.some((m, i) => m.label === "effectIssued" && m.detail === wipeSetup.name && i > iCR && i < iMR),
  seg.filter((m, i) => m.label === "effectIssued" && m.detail === wipeSetup.name && i > iCR && i < iMR)
     .map(m => `${m.t}ms`).join(",") || "none");

// ── §12b the control: the OLD timing, driven by hand ──
// No source is reverted. A handler registered for this one return load calls the sweep at canvasReady
// timing, which is where the retired registration ran it. The deterministic reading is the ORDERING —
// that draw lands before the engine's signal, i.e. inside the wipe window. Whether the wipe actually
// catches it on any given run is the race itself, so it is reported rather than asserted; the tell is
// the reconciler having to re-issue the same mark after the signal, which only happens if the first
// copy was destroyed without being reported.
console.log("\n§12b control — the retired canvasReady timing draws into the wipe window");
const ctlBaseErr = errors.length, ctlBaseRace = engineRaces.length;
const control = await page.evaluate(async ({ mod, homeId, awayId, name }) => {
  const M = await import(mod);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const W = window.__PW_WIPE;
  await game.scenes.get(awayId).view();
  await sleep(5000);
  const from = W.marks.length;
  // Scoped to the return load only, and removed immediately after it.
  const ctl = Hooks.on("canvasReady", () => {
    if (canvas?.scene?.id !== homeId) return;
    W.rec("forcedOldTimingSweep");
    M.syncSceneStatusFx();
  });
  await game.scenes.get(homeId).view();
  await sleep(9000);
  Hooks.off("canvasReady", ctl);
  return {
    from, marks: W.marks.slice(),
    present: M.liveStatusFx().filter(e => String(e?.data?.name ?? "") === name).length,
  };
}, { mod: MOD, homeId: wipeSetup.homeId, awayId: wipeSetup.awayId, name: wipeSetup.name });
await page.waitForTimeout(2000);
const cSeg  = control.marks.slice(control.from);
const cCR   = cSeg.findIndex(m => m.label === "canvasReady");
const cMR   = cSeg.findIndex((m, i) => m.label === "managerReady" && i > cCR);
const cEarly = cSeg.findIndex((m, i) => m.label === "effectIssued" && m.detail === wipeSetup.name && i > cCR && i < cMR);
const cLate  = cSeg.findIndex((m, i) => m.label === "effectIssued" && m.detail === wipeSetup.name && i > cMR);
console.log("  (control load, recorded: " + cSeg.filter(m => m.label !== "effectIssued" || m.detail === wipeSetup.name)
  .map(m => `${m.t}ms ${m.label}`).join(" → ") + ")");
check("the hand-driven old timing issues the mark BEFORE the engine's after-wipe signal (the retired window)",
  cCR >= 0 && cMR > cCR && cEarly > cCR && cEarly < cMR,
  `canvasReady@${cSeg[cCR]?.t}ms draw@${cEarly >= 0 ? cSeg[cEarly]?.t : "—"}ms signal@${cMR >= 0 ? cSeg[cMR]?.t : "—"}ms`);
console.log(`  (race outcome this run: ${errors.length - ctlBaseErr + (engineRaces.length - ctlBaseRace)} uncaught teardown error(s)`
  + `; the wipe ${cLate > cMR ? "ATE the early draw — the reconciler re-issued it after the signal" : "did not catch the early draw"})`);
// Whatever the race did, the reconciler on the engine's signal is what leaves the figure marked.
check("the figure ends the control load marked anyway — the signal-side sweep is the recovery",
  control.present === 1, `${control.present} drawn`);

await page.evaluate(async ({ actorId, tokenId, awayId, homeId }) => {
  const W = window.__PW_WIPE;
  for (const [hook, id] of [["canvasReady", W.ids.canvasReady], ["sequencerEffectManagerReady", W.ids.managerReady],
                            ["createSequencerEffect", W.ids.created], ["endedSequencerEffect", W.ids.ended]]) {
    try { Hooks.off(hook, id); } catch (_e) { /* already off */ }
  }
  delete window.__PW_WIPE;
  const actor = game.actors.get(actorId);
  try { await actor?.toggleStatusEffect("dead", { active: false }); } catch (_e) { /* already clear */ }
  await new Promise(r => setTimeout(r, 1200));
  try { await game.scenes.get(homeId)?.deleteEmbeddedDocuments("Token", [tokenId]); } catch (_e) { /* already gone */ }
  try { await actor?.delete(); } catch (_e) { /* already gone */ }
  try { await game.scenes.get(awayId)?.delete(); } catch (_e) { /* already gone */ }
}, { actorId: wipeSetup.actorId, tokenId: wipeSetup.tokenId, awayId: wipeSetup.awayId, homeId: wipeSetup.homeId });
await page.waitForTimeout(2500);

/* ─────────── §13 WHICH SIGNAL DRIVES THE CATCH-UP SWEEP, and the fallback behind it ───────────
 * §12 proves the ORDERING that the choice buys. This section pins the CHOICE itself, which is the
 * unit's own headline finding and had no named guard: the sweep rides the engine's after-wipe signal
 * `sequencerEffectManagerReady`; `canvasReady` remains only as a generation-counted LATE fallback for
 * a host where that signal never comes; and the retired `sequencerReady` catch-up is not back.
 * Each leg drives the real hook and reads the figure's mark, so a re-wire fails here by outcome. */
console.log("\n§13 the catch-up signal choice");
// Its OWN figure: the shared fixture's token is deleted by §9, so anything after that section which
// needs a marked figure has to build one (§11 and §12 do the same).
const sigFix = await page.evaluate(async () => {
  const actor = await Actor.create({ name: "__PW__SignalSubject", type: "character" });
  const proto = await actor.getTokenDocument({ x: 1400, y: 1400, actorLink: true });
  const [tokenDoc] = await canvas.scene.createEmbeddedDocuments("Token", [proto.toObject()]);
  await new Promise(r => setTimeout(r, 800));
  return { actorId: actor.id, tokenId: tokenDoc.id, onCanvas: !!canvas.tokens.get(tokenDoc.id) };
});
check("the section's own figure is placed and drawn on the canvas", sigFix.onCanvas === true, sigFix.tokenId);
const sig = await page.evaluate(async ({ mod, actorId, TID }) => {
  const M = await import(mod);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const own = () => M.liveStatusFx().filter(e => (e?.data?.creatorUserId ?? game.user.id) === game.user.id
                                             && String(e?.data?.name ?? "").includes(TID));
  const drop = async () => {
    for (const e of own()) { try { Sequencer.EffectManager.endEffects({ name: e.data.name }); } catch (_e) { /* gone */ } }
    await sleep(700);
    return own().length;
  };
  const out = {};
  const actor = game.actors.get(actorId);

  // ⚠ SCAFFOLD, NAMED AND RESTORED. A mark that ends while its condition is still raised is put
  // straight back by the rail's own end-reconciler (`_onEffectEnded`), so "the mark is missing" is a
  // state this section cannot otherwise reach. The end listener is parked for the length of the
  // section and put back at the bottom, and both halves are asserted.
  const endHooks = () => (Hooks.events?.["endedSequencerEffect"] ?? []).filter(x => /STATUS_FX_NAME|statusfx/.test(String(x.fn ?? "")));
  const endBefore = endHooks().length;
  const endEntry = endHooks()[0];
  out.endHookFound = !!endEntry;
  if (endEntry) Hooks.off("endedSequencerEffect", endEntry.id);
  out.endHookCounts = { before: endBefore, parked: endHooks().length };

  // The registered listener set, read off the live hook table (a re-wire changes these).
  const srcOf = (h) => (Hooks.events?.[h] ?? []).map(x => String(x.fn ?? x));
  out.onManagerSignal = srcOf("sequencerEffectManagerReady").filter(s => /syncSceneStatusFx/.test(s)).length;
  out.onCanvasReady   = srcOf("canvasReady").filter(s => /syncSceneStatusFx/.test(s)).length;
  out.onSequencerReady = srcOf("sequencerReady").filter(s => /syncSceneStatusFx/.test(s)).length;
  out.canvasArmIsDeferred = srcOf("canvasReady").some(s => /syncSceneStatusFx/.test(s) && /setTimeout/.test(s) && /Gen/.test(s));

  await actor.toggleStatusEffect("burning", { active: true });
  await sleep(2000);
  out.marked = own().length;

  // (a) the engine's own after-wipe signal is what puts a missing mark back.
  out.droppedA = await drop();
  Hooks.callAll("sequencerEffectManagerReady");
  await sleep(1800);
  out.afterSignal = own().length;

  // (b) the canvasReady fallback is LATE, not immediate — it exists to outlast the engine's setup.
  out.droppedB = await drop();
  Hooks.callAll("canvasReady", canvas);
  await sleep(900);
  out.shortlyAfterCanvasReady = own().length;
  await sleep(3400);
  out.afterFallbackWindow = own().length;

  // (c) the generation counter: a canvas the SIGNAL already served is not swept again by the fallback.
  out.droppedC = await drop();
  Hooks.callAll("canvasReady", canvas);            // opens a fallback window for this generation
  Hooks.callAll("sequencerEffectManagerReady");    // ...which the signal serves first
  await sleep(1800);
  out.servedBySignal = own().length;
  await drop();                                    // take it down again INSIDE the same window
  await sleep(3400);
  out.fallbackDeclined = own().length;

  // (d) NEGATIVE: no referee gate — the overlay is a local read of public state, so it draws for a
  //     client whose referee flag reads false.
  const realIsGM = Object.getOwnPropertyDescriptor(game.user, "isGM");
  Object.defineProperty(game.user, "isGM", { value: false, configurable: true });
  let drawnWithoutGm = null;
  try {
    Hooks.callAll("sequencerEffectManagerReady");
    await sleep(1800);
    drawnWithoutGm = own().length;
  } finally {
    if (realIsGM) Object.defineProperty(game.user, "isGM", realIsGM);
    else Object.defineProperty(game.user, "isGM", { value: true, configurable: true });
  }
  out.drawnWithoutGm = drawnWithoutGm;
  out.gmFlagRestored = game.user.isGM === true;

  if (endEntry) Hooks.on("endedSequencerEffect", endEntry.fn);
  out.endHookCounts.restored = endHooks().length;

  await actor.toggleStatusEffect("burning", { active: false });
  await sleep(1500);
  out.cleared = own().length;
  return out;
}, { mod: MOD, actorId: sigFix.actorId, TID: sigFix.tokenId });
check("the fixture figure is wearing its mark before the signal legs run", sig.marked === 1, `${sig.marked} drawn`);
check("the catch-up sweep is registered on the engine's own after-wipe signal",
  sig.onManagerSignal === 1, `${sig.onManagerSignal} listener(s) carrying the sweep`);
check("that signal redraws a mark the engine no longer holds",
  sig.droppedA === 0 && sig.afterSignal === 1, `dropped to ${sig.droppedA}, back to ${sig.afterSignal}`);
check("canvas load carries only a DEFERRED, generation-counted fallback sweep",
  sig.onCanvasReady === 1 && sig.canvasArmIsDeferred === true,
  `${sig.onCanvasReady} listener(s), deferred+generation-counted: ${sig.canvasArmIsDeferred}`);
check("the fallback does not draw straight away, and does draw once its window elapses",
  sig.droppedB === 0 && sig.shortlyAfterCanvasReady === 0 && sig.afterFallbackWindow === 1,
  `at ~0.9s: ${sig.shortlyAfterCanvasReady}; after the window: ${sig.afterFallbackWindow}`);
check("NEGATIVE: a canvas the signal already served is NOT swept again by the fallback",
  sig.droppedC === 0 && sig.servedBySignal === 1 && sig.fallbackDeclined === 0,
  `signal served ${sig.servedBySignal}; after the window, with the mark taken down inside it: ${sig.fallbackDeclined}`);
check("NEGATIVE: the retired ready-time catch-up is not registered any more",
  sig.onSequencerReady === 0, `${sig.onSequencerReady} listener(s) on sequencerReady`);
check("NEGATIVE: condition overlays carry no referee gate — the mark draws with that flag standing down",
  sig.drawnWithoutGm === 1 && sig.gmFlagRestored === true,
  `drawn with the flag false: ${sig.drawnWithoutGm}; flag restored: ${sig.gmFlagRestored}`);
check("the end-reconciler scaffold was parked for the section and put back afterwards",
  sig.endHookFound === true && sig.endHookCounts?.before === 1
  && sig.endHookCounts?.parked === 0 && sig.endHookCounts?.restored === 1,
  `listeners carrying the condition-overlay end reconciler: ${sig.endHookCounts?.before} -> ${sig.endHookCounts?.parked} -> ${sig.endHookCounts?.restored}`);
check("the section left the figure clean", sig.cleared === 0, `${sig.cleared} left`);
await page.evaluate(async ({ actorId, tokenId }) => {
  try { await canvas.scene.deleteEmbeddedDocuments("Token", [tokenId]); } catch (_e) { /* already gone */ }
  try { await game.actors.get(actorId)?.delete(); } catch (_e) { /* already gone */ }
}, { actorId: sigFix.actorId, tokenId: sigFix.tokenId });
await page.waitForTimeout(1200);

console.log("\n§14 the re-issue guard");
// A mark that ends moments after drawing did not age out — the end-reconciler tolerates two rapid
// ends (each redraws), pauses on the third, and the pause gates ONLY the ended-hook: a real
// condition mutation still redraws through the sync path.
const grdFix = await page.evaluate(async () => {
  const actor = await Actor.create({ name: "__PW__GuardSubject", type: "character" });
  const proto = await actor.getTokenDocument({ x: 1700, y: 1400, actorLink: true });
  const [tokenDoc] = await canvas.scene.createEmbeddedDocuments("Token", [proto.toObject()]);
  await new Promise(r => setTimeout(r, 800));
  return { actorId: actor.id, tokenId: tokenDoc.id, onCanvas: !!canvas.tokens.get(tokenDoc.id) };
});
check("the guard section's figure is placed and drawn on the canvas", grdFix.onCanvas === true, grdFix.tokenId);
const grd = await page.evaluate(async ({ mod, actorId, TID }) => {
  const M = await import(mod);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const own = () => M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID));
  const endRaw = async () => {   // an end the module did NOT intend — the reconciler's redraw case
    for (const e of own()) { try { Sequencer.EffectManager.endEffects({ name: e.data.name }); } catch (_e) { /* gone */ } }
    await sleep(1000);
    return own().length;
  };
  const out = {};
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warns.push(a.map(String).join(" ")); realWarn(...a); };
  try {
    const actor = game.actors.get(actorId);
    await actor.toggleStatusEffect("burning", { active: true });
    await sleep(2000);
    out.marked = own().length;
    out.afterEnd1 = await endRaw();     // strike 1 → redrawn
    out.afterEnd2 = await endRaw();     // strike 2 → redrawn
    out.afterEnd3 = await endRaw();     // strike 3 → paused, stays down
    await sleep(1500);
    out.stillDown = own().length;
    out.pauseWarns = warns.filter(w => w.includes("re-issue paused")).length;
    // The sync path ignores the pause: a real mutation redraws the mark.
    await actor.toggleStatusEffect("burning", { active: false });
    await sleep(800);
    await actor.toggleStatusEffect("burning", { active: true });
    await sleep(2000);
    out.syncRedraws = own().length;
    await actor.toggleStatusEffect("burning", { active: false });
    await sleep(1500);
    out.cleared = own().length;
  } finally {
    console.warn = realWarn;
  }
  return out;
}, { mod: MOD, actorId: grdFix.actorId, TID: grdFix.tokenId });
check("the guard figure wears its mark before the ends run", grd.marked === 1, `${grd.marked} drawn`);
check("two rapid unintended ends are each answered with a redraw",
  grd.afterEnd1 === 1 && grd.afterEnd2 === 1, `after end 1: ${grd.afterEnd1}; after end 2: ${grd.afterEnd2}`);
check("the third rapid end trips the pause — the mark stays down",
  grd.afterEnd3 === 0 && grd.stillDown === 0, `after end 3: ${grd.afterEnd3}; later: ${grd.stillDown}`);
check("the trip warns exactly once, naming the pause", grd.pauseWarns === 1, `${grd.pauseWarns} warn(s)`);
check("NEGATIVE for the pause's scope: a real condition mutation still redraws through the sync path",
  grd.syncRedraws === 1, `${grd.syncRedraws} drawn under pause`);
check("the guard section left the figure clean", grd.cleared === 0, `${grd.cleared} left`);
await page.evaluate(async ({ actorId, tokenId }) => {
  try { await canvas.scene.deleteEmbeddedDocuments("Token", [tokenId]); } catch (_e) { /* already gone */ }
  try { await game.actors.get(actorId)?.delete(); } catch (_e) { /* already gone */ }
}, { actorId: grdFix.actorId, tokenId: grdFix.tokenId });
await page.waitForTimeout(1200);

/* ─────────────────── cleanup ─────────────────── */
await page.evaluate(async ({ actorId, tokenId }) => {
  try { await canvas.scene.deleteEmbeddedDocuments("Token", [tokenId]); } catch (_e) { /* already gone */ }
  try { await game.actors.get(actorId)?.delete(); } catch (_e) { /* already gone */ }
}, { actorId: fixture.actorId, tokenId: fixture.tokenId });

console.log("\n§10 console");
if (engineRaces.length) console.log(`  (engine teardown races ignored: ${engineRaces.length})`);
check("0 console errors", errors.length === 0, errors.slice(0, 4).join(" | "));

console.log(`\n${pass}/${pass + fail} checks passed`);
await browser.close();
process.exit(fail ? 1 : 0);
