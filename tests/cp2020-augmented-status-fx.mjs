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
 *  - two conditions at once drawing two marks at two offsets
 *  - RELOAD: a full page reload with the condition still on redraws it (nothing is persisted)
 *  - figure deleted → its marks swept by name
 *  - the world switch off → nothing drawn, and the sweep takes down what was already there
 *  - no document is written: the scene's own effect flags stay empty throughout
 *  - the missing-key degrade, through the rail's existing database seam
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
eq("the shipped database keys", pure.rowKeys, [
  "jb2a.flames.02.orange",
  "jb2a.markers.poison.dark_green.02",
  "jb2a.bubble.002.001.loop.blue",
  "jb2a.markers.stun.purple.02",
  "jb2a.markers.simple.001.loop.001.red",
]);
check("the stamped name encodes figure then row", pure.namesFor === "cp2020-augmented.statusfx.TOKENID.burning", pure.namesFor);

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
eq("badge slot 0 sits left of centre, above the figure", geo.poison1, { x: -0.21, y: -0.8 });
eq("badge slot 1 sits right of centre, same height", geo.stun1, { x: 0.21, y: -0.8 });
eq("body slot 0 is nudged left of the figure's centre", geo.burn1, { x: -0.11, y: 0 });
eq("body slot 1 is nudged right by the same amount", geo.acid1, { x: 0.11, y: 0 });
eq("a ground mark takes no offset", geo.dead1, { x: 0, y: 0 });
eq("a 2-square figure wears its badges outside itself", geo.poison2, { x: -0.21, y: -1.3 });
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

/* ─────────────────── §3 the live path, core condition ─────────────────── */
console.log("\n§3 live path — a core condition draws and clears");
const live1 = await page.evaluate(async ({ mod, actorId, TID }) => {
  const M = await import(mod);
  const actor = game.actors.get(actorId);
  await actor.toggleStatusEffect("burning", { active: true });
  await new Promise(r => setTimeout(r, 2000));
  const drawn = M.liveStatusFx().map(e => e?.data?.name).filter(n => String(n).includes(TID));
  const files = M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID)).map(e => String(e?.data?.file ?? ""));
  await actor.toggleStatusEffect("burning", { active: false });
  await new Promise(r => setTimeout(r, 1500));
  return { drawn, files, after: M.liveStatusFx().map(e => e?.data?.name).filter(n => String(n).includes(TID)) };
}, { mod: MOD, actorId: fixture.actorId, TID: fixture.tokenId });
const burnName = `cp2020-augmented.statusfx.${fixture.tokenId}.burning`;
eq("condition set → exactly one mark, under the stamped name", live1.drawn, [burnName]);
eq("the drawn entry is the decoded side-elevation flame key", live1.files, ["jb2a.flames.02.orange"]);
eq("condition cleared → the mark is gone", live1.after, []);

/* ─────────────────── §4 the module-flag road ─────────────────── */
console.log("\n§4 live path — the module's own lasting-damage flag");
const live2 = await page.evaluate(async ({ mod, actorId, TID }) => {
  const M = await import(mod);
  const actor = game.actors.get(actorId);
  await actor.setFlag("cp2020-augmented", "dotState", [{ location: "Torso", turnsLeft: 3 }]);
  await new Promise(r => setTimeout(r, 2000));
  const drawn = M.liveStatusFx().map(e => e?.data?.name).filter(n => String(n).includes(TID));
  const files = M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID)).map(e => String(e?.data?.file ?? ""));
  await actor.unsetFlag("cp2020-augmented", "dotState");
  await new Promise(r => setTimeout(r, 1500));
  return { drawn, files, after: M.liveStatusFx().map(e => e?.data?.name).filter(n => String(n).includes(TID)) };
}, { mod: MOD, actorId: fixture.actorId, TID: fixture.tokenId });
eq("armour-degradation flag written → the acid mark appears", live2.drawn,
  [`cp2020-augmented.statusfx.${fixture.tokenId}.acid`]);
eq("the drawn entry is the bubbling-loop key", live2.files, ["jb2a.bubble.002.001.loop.blue"]);
eq("flag cleared → the mark is gone", live2.after, []);

/* ─────────────────── §5 stacking ─────────────────── */
console.log("\n§5 two conditions at once");
const stack = await page.evaluate(async ({ mod, actorId, TID }) => {
  const M = await import(mod);
  const actor = game.actors.get(actorId);
  await actor.toggleStatusEffect("burning", { active: true });
  await actor.toggleStatusEffect("poison", { active: true });
  await new Promise(r => setTimeout(r, 2500));
  const eff = M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID));
  const out = {
    names: eff.map(e => e?.data?.name).sort(),
    offsets: eff.map(e => ({ n: String(e?.data?.name ?? "").split(".").pop(), x: e?.data?.spriteOffset?.x ?? null })),
    sceneFlagKeys: Object.keys(canvas.scene.flags?.sequencer ?? {}).length,
  };
  await actor.toggleStatusEffect("burning", { active: false });
  await actor.toggleStatusEffect("poison", { active: false });
  await new Promise(r => setTimeout(r, 1500));
  out.after = M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID)).length;
  return out;
}, { mod: MOD, actorId: fixture.actorId, TID: fixture.tokenId });
eq("both marks are drawn, one per condition", stack.names, [
  `cp2020-augmented.statusfx.${fixture.tokenId}.burning`,
  `cp2020-augmented.statusfx.${fixture.tokenId}.poison`,
].sort());
const offX = Object.fromEntries(stack.offsets.map(o => [o.n, o.x]));
check("the two marks sit at two different offsets",
  offX.burning !== null && offX.poison !== null && offX.burning !== offX.poison,
  JSON.stringify(offX));
check("no document was written: the scene carries no effect flags", stack.sceneFlagKeys === 0, String(stack.sceneFlagKeys));
check("both cleared → nothing left", stack.after === 0, String(stack.after));

/* ─────────────────── §5b the other two placement branches ─────────────────── */
console.log("\n§5b the ground branch and the recolour");
const branches = await page.evaluate(async ({ mod, actorId, TID }) => {
  const M = await import(mod);
  const actor = game.actors.get(actorId);
  const grab = (id) => {
    const e = M.liveStatusFx().find(x => String(x?.data?.name ?? "") === `cp2020-augmented.statusfx.${TID}.${id}`);
    // `sortLayer` is where Sequencer records belowTokens (600); `aboveLighting` is the other routing.
    return e ? { file: String(e.data.file ?? ""), sortLayer: e.data.sortLayer ?? null,
                 aboveLighting: e.data.aboveLighting ?? null,
                 filters: JSON.stringify(e.data.filters ?? e.data.filter ?? null).slice(0, 200) } : null;
  };
  const out = {};
  // A body row for contrast, so "routed differently" is a comparison and not a lone constant.
  await actor.toggleStatusEffect("burning", { active: true });
  await new Promise(r => setTimeout(r, 2000));
  out.burning = grab("burning");
  await actor.toggleStatusEffect("burning", { active: false });
  await new Promise(r => setTimeout(r, 1200));
  // The ground row, which is the only one taking the below-tokens branch.
  await actor.toggleStatusEffect("dead", { active: true });
  await new Promise(r => setTimeout(r, 2000));
  out.dead = grab("dead");
  out.deadNames = M.liveStatusFx().map(e => e?.data?.name).filter(n => String(n).includes(TID));
  await actor.toggleStatusEffect("dead", { active: false });
  await new Promise(r => setTimeout(r, 1200));
  // The recoloured row, which is the only one taking the filter branch.
  await actor.setFlag("cp2020-augmented", "dotState", [{ location: "Torso", turnsLeft: 1 }]);
  await new Promise(r => setTimeout(r, 2000));
  out.acid = grab("acid");
  await actor.unsetFlag("cp2020-augmented", "dotState");
  await new Promise(r => setTimeout(r, 1200));
  out.after = M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID)).length;
  return out;
}, { mod: MOD, actorId: fixture.actorId, TID: fixture.tokenId });
eq("the ground row draws exactly one mark, and the stunned row is not raised with it",
  branches.deadNames, [`cp2020-augmented.statusfx.${fixture.tokenId}.dead`]);
check("the ground row carries the simple-marker loop key",
  branches.dead?.file === "jb2a.markers.simple.001.loop.001.red", JSON.stringify(branches.dead));
check("the ground row is routed below the figures", branches.dead?.sortLayer === 600,
  `sortLayer ${branches.dead?.sortLayer}`);
check("and the two routings genuinely differ: the body row is lifted above the lighting instead",
  branches.burning?.aboveLighting === true && branches.burning?.sortLayer !== 600,
  `body ${JSON.stringify(branches.burning)} vs ground ${JSON.stringify(branches.dead)}`);
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
  const out = { drawn: M.liveStatusFx().map(e => e?.data?.name).filter(n => String(n).includes(TID)) };
  await game.actors.get(actorId).toggleStatusEffect("burning", { active: false });
  await new Promise(r => setTimeout(r, 1500));
  out.after = M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID)).length;
  return out;
}, { mod: MOD, actorId: fixture.actorId, TID: fixture.tokenId });
check("nothing was persisted into the scene before the reload", flagsBeforeReload === 0, String(flagsBeforeReload));
eq("after a full reload the mark is drawn again", afterReload.drawn, [burnName]);
check("and it still clears with the condition", afterReload.after === 0, String(afterReload.after));

/* ─────────────────── §7 the world switch ─────────────────── */
console.log("\n§7 the world switch");
const sw = await page.evaluate(async ({ mod, actorId, TID }) => {
  const M = await import(mod);
  const actor = game.actors.get(actorId);
  const prior = game.settings.get("cp2020-augmented", "combatFxEnabled");
  const out = {};
  try {
    await actor.toggleStatusEffect("burning", { active: true });
    await new Promise(r => setTimeout(r, 1800));
    out.onCount = M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID)).length;
    await game.settings.set("cp2020-augmented", "combatFxEnabled", false);
    // The switch is read per event, so the sweep is what a next event would do.
    M.syncSceneStatusFx();
    await new Promise(r => setTimeout(r, 1500));
    out.sweptCount = M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID)).length;
    await actor.toggleStatusEffect("burning", { active: false });
    await actor.toggleStatusEffect("poison", { active: true });
    await new Promise(r => setTimeout(r, 1800));
    out.offCount = M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID)).length;
  } finally {
    await game.settings.set("cp2020-augmented", "combatFxEnabled", prior);
    await actor.toggleStatusEffect("poison", { active: false }).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    out.restored = game.settings.get("cp2020-augmented", "combatFxEnabled");
    out.finalCount = M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID)).length;
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
  const FX = await import("/modules/cp2020-augmented/module/fx/effects.js");
  const actor = game.actors.get(actorId);
  const out = {};
  try {
    FX._setDbProbe(() => false);
    await actor.toggleStatusEffect("burning", { active: true });
    await new Promise(r => setTimeout(r, 1500));
    out.drawn = M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID)).length;
  } finally {
    FX._setDbProbe(null);
    await actor.toggleStatusEffect("burning", { active: false }).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    out.after = M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID)).length;
  }
  return out;
}, { mod: MOD, actorId: fixture.actorId, TID: fixture.tokenId });
check("NEGATIVE: a key the installed tier lacks is skipped, not played", degrade.drawn === 0, String(degrade.drawn));
check("and the seam restored cleanly", degrade.after === 0, String(degrade.after));

/* ─────────────────── §9 figure deleted ─────────────────── */
console.log("\n§9 the figure is deleted while wearing a mark");
const del = await page.evaluate(async ({ mod, actorId, tokenId, TID }) => {
  const M = await import(mod);
  const actor = game.actors.get(actorId);
  await actor.toggleStatusEffect("burning", { active: true });
  await new Promise(r => setTimeout(r, 1800));
  const before = M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID)).length;
  await canvas.scene.deleteEmbeddedDocuments("Token", [tokenId]);
  await new Promise(r => setTimeout(r, 1800));
  return { before, after: M.liveStatusFx().filter(e => String(e?.data?.name ?? "").includes(TID)).length };
}, { mod: MOD, actorId: fixture.actorId, tokenId: fixture.tokenId, TID: fixture.tokenId });
check("the mark was up before the delete", del.before === 1, String(del.before));
check("the figure's marks are swept by name when it goes", del.after === 0, String(del.after));

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
