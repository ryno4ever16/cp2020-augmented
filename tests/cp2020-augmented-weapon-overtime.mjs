/**
 * Keeper — over-time effects ON WEAPONS, and the acid rule read the book's way (2026-09-19).
 *
 * What this pins, by value:
 *  §1 the weapon model persists a LIST of effect rows on a vanilla host (the base model strips
 *     undeclared fields; the module's extension declares these)
 *  §2 the seam hands the rows to the payload — for a melee weapon with no ammo at all, and beside a
 *     loaded round's own statement
 *  §3 the pure list: legacy single statement + rows, normalised; junk dropped
 *  §4 acid, the book's way: rolled ONCE at the hit and reused each round; the location's armour loses
 *     that number per round; the round the armour runs out the remainder SEARS THROUGH as damage and the
 *     acid is spent (Core p.107 worked example)
 *  §5 a blank roll uses the hit's own damage (the squirtgun); a hit that PENETRATED eats but never sears
 *  §6 a fire row burns; two rows apply together; a marker written before the change still ticks
 *  §7 the sheet: add, seed-on-type, edit, remove — real clicks, values persisted
 *  §8 client health
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=<pw> node tests/cp2020-augmented-weapon-overtime.mjs
 */
import { chromium } from "playwright";

const URL = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const eq = (n, got, want) => check(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(m.text())) errors.push(m.text()); });
page.on("pageerror", e => errors.push(e.message));

async function joinGM(p) {
  await p.goto(`${URL}/join`);
  await p.waitForSelector('select[name="userid"]');
  const uid = await p.$$eval('select[name="userid"] option', os => os.find(o => /gamemaster/i.test(o.textContent))?.value);
  await p.selectOption('select[name="userid"]', uid);
  await p.fill('input[name="password"]', PW);
  await p.click('button[name="join"]');
  await p.waitForFunction(() => globalThis.game?.ready, null, { timeout: 90000 });
}
await joinGM(page);
await page.waitForFunction(() => globalThis.canvas?.ready, null, { timeout: 60000 });

const SAVES = "/modules/cp2020-augmented/module/combat/save-rolls.js";
const SEAM = "/modules/cp2020-augmented/module/seam-shim.js";
const APPL = "/modules/cp2020-augmented/module/combat/DamageApplicator.js";

/* ─────────────────── §1 the model ─────────────────── */
console.log("\n§1 the weapon model persists the rows");
const model = await page.evaluate(async () => {
  const out = {};
  let w = null;
  try {
    w = await Item.create({ name: "__PW__OT Monokatana", type: "weapon", system: {
      weaponType: "melee", damage: "4d6", mono: true,
      overTime: [{ type: "acid", turns: 3, formula: "1d6", flat: false }, { type: "fire", turns: 2, formula: "1d6", flat: true }],
    } });
    // _source is a LIVE reference — clone at read time or a later update rewrites the earlier read
    out.stored = foundry.utils.deepClone(w._source.system.overTime);
    out.prepared = foundry.utils.deepClone(w.system.overTime);
    out.monoKept = w.system.mono === true;
    await w.update({ "system.overTime": [{ type: "acid", turns: 5, formula: "", flat: false }] });
    out.updated = foundry.utils.deepClone(w._source.system.overTime);
    // the sheet's numbered-object form of the same array casts back to an array
    await w.update({ "system.overTime": { 0: { type: "fire", turns: 1, formula: "2d6", flat: false }, 1: { type: "acid", turns: 3, formula: "", flat: false } } });
    out.fromObject = foundry.utils.deepClone(w._source.system.overTime);
    out.empty = (await Item.create({ name: "__PW__OT Plain", type: "weapon", system: { weaponType: "melee" } }))._source.system.overTime;
  } catch (e) { out.threw = String(e?.message ?? e); }
  finally { for (const it of game.items.filter(i => /^__PW__OT/.test(i.name))) await it.delete().catch(() => {}); }
  return out;
});
check("the model section ran", !model.threw, String(model.threw ?? ""));
eq("two rows are stored on a vanilla weapon, as authored", model.stored,
  [{ type: "acid", turns: 3, formula: "1d6", flat: false }, { type: "fire", turns: 2, formula: "1d6", flat: true }]);
eq("and prepared", model.prepared?.length, 2);
check("the melee flags beside them survive", model.monoKept === true);
eq("an update replaces the list", model.updated, [{ type: "acid", turns: 5, formula: "", flat: false }]);
eq("the sheet's numbered-object write casts back to an ordered array", model.fromObject,
  [{ type: "fire", turns: 1, formula: "2d6", flat: false }, { type: "acid", turns: 3, formula: "", flat: false }]);
eq("NEGATIVE: a weapon with no rows stores an empty list — a weapon as it always was", model.empty, []);

/* ─────────────────── §2 the seam ─────────────────── */
console.log("\n§2 the seam carries the rows");
const seam = await page.evaluate(async (SEAM) => {
  const S = await import(SEAM);
  const out = {};
  let a = null;
  try {
    a = await Actor.create({ name: "__PW__OT Shooter", type: "character" });
    // createEmbeddedDocuments returns in ITS order, not the input's — resolve by name (keeper gotcha)
    const created = await a.createEmbeddedDocuments("Item", [
      { name: "__PW__OT Blade", type: "weapon", system: { weaponType: "melee", damage: "4d6", overTime: [{ type: "acid", turns: 3, formula: "1d6", flat: false }] } },
      { name: "__PW__OT Gun", type: "weapon", system: { weaponType: "pistol", damage: "2d6", overTime: [{ type: "acid", turns: 3, formula: "", flat: false }] } },
      { name: "__PW__OT Acid Round", type: "ammo", system: { modifier: "custom", dotEnabled: true, dotTurns: 2, dotType: "fire", dotDamageFormula: "1d6" } },
    ]);
    const byName = (n) => created.find(i => i.name === n);
    const blade = byName("__PW__OT Blade"), gun = byName("__PW__OT Gun"), acidAmmo = byName("__PW__OT Acid Round");
    out.melee = S.ammoEffectFields(blade).overTime;
    await gun.update({ "system.ammoItemId": acidAmmo.id });
    const f = S.ammoEffectFields(gun);
    out.loaded = { overTime: f.overTime, dotEnabled: f.dotEnabled, dotType: f.dotType };
    const plain = (await a.createEmbeddedDocuments("Item", [{ name: "__PW__OT Plain", type: "weapon", system: { weaponType: "melee" } }]))[0];
    out.none = S.ammoEffectFields(plain).overTime;
  } catch (e) { out.threw = String(e?.message ?? e); }
  finally { await a?.delete().catch(() => {}); }
  return out;
}, SEAM);
check("the seam section ran", !seam.threw, String(seam.threw ?? ""));
eq("a melee weapon with no ammo hands its rows to the payload", seam.melee, [{ type: "acid", turns: 3, formula: "1d6", flat: false }]);
eq("a loaded gun hands BOTH the round's statement and its own rows", seam.loaded,
  { overTime: [{ type: "acid", turns: 3, formula: "", flat: false }], dotEnabled: true, dotType: "fire" });
eq("NEGATIVE: no rows, an empty list", seam.none, []);

/* ─────────────────── §3 the pure list ─────────────────── */
console.log("\n§3 the pure list");
const pure = await page.evaluate(async (SAVES) => {
  const V = await import(SAVES);
  return {
    legacyOnly: V.overTimeEntries({ dotEnabled: true, dotTurns: 2, dotType: "fire", dotDamageFormula: "1d6", dotFlat: true }),
    rowsOnly: V.overTimeEntries({ overTime: [{ type: "acid", turns: 3, formula: "1d6" }] }),
    both: V.overTimeEntries({ dotEnabled: true, dotTurns: 2, dotType: "fire", dotDamageFormula: "1d6", overTime: [{ type: "acid", turns: 3, formula: "" }] }).map(e => e.type),
    junk: V.overTimeEntries({ overTime: [{ type: "plasma", turns: 3 }, { type: "acid", turns: 0 }, { type: "FIRE", turns: 1.9, formula: " 2d6 " }] }),
    off: V.overTimeEntries({ dotEnabled: false, dotTurns: 3, dotType: "acid" }),
    nothing: V.overTimeEntries(null),
  };
}, SAVES);
eq("the round's single statement is one entry", pure.legacyOnly, [{ type: "fire", turns: 2, formula: "1d6", flat: true }]);
eq("the weapon's rows are entries", pure.rowsOnly, [{ type: "acid", turns: 3, formula: "1d6", flat: false }]);
eq("both sources, both entries, the round's first", pure.both, ["fire", "acid"]);
eq("junk is dropped: unknown type, zero turns; a type is case-folded, turns floored, a formula trimmed", pure.junk,
  [{ type: "fire", turns: 1, formula: "2d6", flat: false }]);
eq("NEGATIVE: a round with the statement OFF is no entry", pure.off, []);
eq("NEGATIVE: nothing is nothing", pure.nothing, []);

/* ─────────────────── §4 acid, the book's way ─────────────────── */
console.log("\n§4 acid — rolled once, reused, sears through");
const acid = await page.evaluate(async ({ SAVES, APPL }) => {
  const V = await import(SAVES); const A = await import(APPL);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  const scene = game.scenes.viewed ?? game.scenes.active;
  const made = [];
  const cov = (sp) => Object.fromEntries(["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"].map(k => [k, { stoppingPower: sp }]));
  const mk = async (name, sp) => {
    const a = await Actor.create({ name, type: "character" });
    made.push(a);
    await a.createEmbeddedDocuments("Item", [{ name: name + " Coat", type: "armor", system: { equipped: true, armorType: "Soft", coverage: cov(sp) } }]);
    return a;
  };
  const torsoSP = (a) => A.effectiveArmorSP(a, "Torso");
  const dmg = (a) => Number(a.system?.damage) || 0;
  const msgIdsBefore = new Set(game.messages.contents.map(m => m.id));
  const tickWas = game.settings.get("cp2020-augmented", "mechRoundTickAutomation");
  let combat = null; const toks = [];
  try {
    await game.settings.set("cp2020-augmented", "mechRoundTickAutomation", true);
    // (a) a stated formula is rolled ONCE at the hit: the marker carries the number
    const a1 = await mk("__PW__OT Target A", 10);
    const wrote = await V.applyDotFromPayload(a1, "Torso", { overTime: [{ type: "acid", turns: 3, formula: "4", flat: false }] }, false, 99);
    const m1 = (a1.getFlag("cp2020-augmented", "dotState") ?? [])[0];
    out.marker = m1;
    out.corrode = a1.statuses?.has("corrode") === true;
    // (b) three real rounds: 10 → 6 → 2 → the third round eats the last 2 and sears 2 through, then the acid is spent
    [toks[0]] = await scene.createEmbeddedDocuments("Token", [{ name: a1.name, actorId: a1.id, actorLink: true, x: 1500, y: 1500, hidden: true }]);
    combat = await Combat.create({ scene: scene.id, active: true });
    await combat.createEmbeddedDocuments("Combatant", [{ tokenId: toks[0].id, actorId: a1.id }]);
    await combat.startCombat(); await sleep(300);
    const step = async (a) => {
      const before = { sp: torsoSP(a), dmg: dmg(a), turns: (a.getFlag("cp2020-augmented", "dotState") ?? [])[0]?.turnsLeft ?? null };
      await combat.nextRound();
      for (let i = 0; i < 40; i++) { await sleep(150); if (torsoSP(a) !== before.sp || dmg(a) !== before.dmg || ((a.getFlag("cp2020-augmented", "dotState") ?? [])[0]?.turnsLeft ?? null) !== before.turns) break; }
      await sleep(400);
      // the flag write is the tick's LAST act (after the damage, the cards and the stun prompt): wait
      // for the marker to move on from what it was before the round, bounded
      for (let i = 0; i < 40; i++) { const m = (a.getFlag("cp2020-augmented", "dotState") ?? [])[0] ?? null; if ((m?.turnsLeft ?? null) !== before.turns) break; await sleep(150); }
      // the corrode condition is mirrored off AFTER the last marker's flag write (a separate document
      // op) — polled, bounded, or the read lands between the two (one red, 2026-09-19)
      const gone = !((a.getFlag("cp2020-augmented", "dotState") ?? [])[0]);
      if (gone) for (let i = 0; i < 40 && a.statuses?.has("corrode"); i++) await sleep(100);
      return { sp: torsoSP(a), dmg: dmg(a), marker: (a.getFlag("cp2020-augmented", "dotState") ?? [])[0] ?? null, corrode: a.statuses?.has("corrode") === true };
    };
    out.r1 = await step(a1);
    out.r2 = await step(a1);
    out.r3 = await step(a1);
    out.r1PerRound = out.r1.marker?.perRound ?? null;
    out.btm = Number(a1.system?.stats?.bt?.modifier) || 0;
    out.chatAcid = game.messages.contents.filter(m => !msgIdsBefore.has(m.id) && /acid/i.test(m.content ?? m.flavor ?? "")).length;
  } catch (e) { out.threw = String(e?.message ?? e) + " " + String(e?.stack ?? "").split("\n")[1]; }
  finally {
    try { await combat?.delete(); } catch (_e) {}
    for (const t of toks) { try { await t?.delete(); } catch (_e) {} }
    for (const a of made) { try { await a.delete(); } catch (_e) {} }
    await game.settings.set("cp2020-augmented", "mechRoundTickAutomation", tickWas);
    for (const m of game.messages.contents) if (!msgIdsBefore.has(m.id)) await m.delete().catch(() => {});
  }
  return out;
}, { SAVES, APPL });
check("the acid section ran", !acid.threw, String(acid.threw ?? ""));
eq("⭐ the marker carries the NUMBER, rolled once at the hit (a stated 4 is 4)", acid.marker?.perRound, 4);
eq("and its duration", acid.marker?.turnsLeft, 3);
check("and that armour held the hit off (the acid still owes its damage)", acid.marker?.stoppedByArmor === true);
check("the corrode condition is raised with it", acid.corrode === true);
eq("round 1: the armour loses the number, 10 → 6", acid.r1.sp, 6);
eq("round 1: nothing reaches the body", acid.r1.dmg, 0);
eq("round 1: the same number is kept for the next round — no re-roll", acid.r1PerRound, 4);
eq("round 2: 6 → 2", acid.r2.sp, 2);
eq("round 2: still nothing through, two rounds left → one", acid.r2.marker?.turnsLeft, 1);
eq("⭐ round 3: the last 2 SP are eaten", acid.r3.sp, 0);
check("⭐ round 3: the remaining 2 acid SEAR THROUGH as damage (after BTM, floored at 1)",
  acid.r3.dmg === Math.max(1, 2 - acid.btm), `damage ${acid.r3.dmg}, btm ${acid.btm}`);
eq("and the acid is spent — the marker is gone", acid.r3.marker, null);
check("and the corrode condition comes off with it", acid.r3.corrode === false);
check("the rounds were narrated in chat", acid.chatAcid >= 3, String(acid.chatAcid));

/* ─────────────────── §5 the squirtgun and the penetrating hit ─────────────────── */
console.log("\n§5 a blank roll is the hit's own damage; a penetrating hit never sears");
const squirt = await page.evaluate(async ({ SAVES, APPL }) => {
  const V = await import(SAVES); const A = await import(APPL);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  const scene = game.scenes.viewed ?? game.scenes.active;
  const made = [];
  const cov = (sp) => Object.fromEntries(["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"].map(k => [k, { stoppingPower: sp }]));
  const mk = async (name, sp) => {
    const a = await Actor.create({ name, type: "character" }); made.push(a);
    await a.createEmbeddedDocuments("Item", [{ name: name + " Coat", type: "armor", system: { equipped: true, armorType: "Soft", coverage: cov(sp) } }]);
    return a;
  };
  const msgIdsBefore = new Set(game.messages.contents.map(m => m.id));
  const tickWas = game.settings.get("cp2020-augmented", "mechRoundTickAutomation");
  let combat = null; const toks = [];
  try {
    await game.settings.set("cp2020-augmented", "mechRoundTickAutomation", true);
    // (a) blank formula: the hit's own rolled damage (7, two pellets) is the acid
    const a1 = await mk("__PW__OT Squirted", 15);
    await V.applyDotFromPayload(a1, "Torso", { overTime: [{ type: "acid", turns: 3, formula: "", flat: false }] }, false, 7);
    out.squirtMarker = (a1.getFlag("cp2020-augmented", "dotState") ?? [])[0] ?? null;
    // (b) zero damage with a blank formula writes nothing
    const a2 = await mk("__PW__OT Missed", 15);
    await V.applyDotFromPayload(a2, "Torso", { overTime: [{ type: "acid", turns: 3, formula: "", flat: false }] }, false, 0);
    out.zeroMarker = a2.getFlag("cp2020-augmented", "dotState") ?? null;
    // (c) a hit that PENETRATED: the marker eats the armour but never sears — its damage already landed
    const a3 = await mk("__PW__OT Penetrated", 3);
    await V.applyDotFromPayload(a3, "Torso", { overTime: [{ type: "acid", turns: 3, formula: "5", flat: false }] }, true, 9);
    out.penMarker = (a3.getFlag("cp2020-augmented", "dotState") ?? [])[0] ?? null;
    [toks[0]] = await scene.createEmbeddedDocuments("Token", [{ name: a3.name, actorId: a3.id, actorLink: true, x: 1500, y: 1500, hidden: true }]);
    combat = await Combat.create({ scene: scene.id, active: true });
    await combat.createEmbeddedDocuments("Combatant", [{ tokenId: toks[0].id, actorId: a3.id }]);
    await combat.startCombat(); await sleep(300);
    const before = A.effectiveArmorSP(a3, "Torso");
    await combat.nextRound();
    for (let i = 0; i < 40; i++) { await sleep(150); if (A.effectiveArmorSP(a3, "Torso") !== before) break; }
    await sleep(400);
    out.pen = { sp: A.effectiveArmorSP(a3, "Torso"), dmg: Number(a3.system?.damage) || 0, marker: (a3.getFlag("cp2020-augmented", "dotState") ?? [])[0] ?? null };
    // Ripperjack's own numbers: SP 15, two pellets rolling 7 → 8 → 1 → 6 through
    [toks[1]] = await scene.createEmbeddedDocuments("Token", [{ name: a1.name, actorId: a1.id, actorLink: true, x: 1600, y: 1500, hidden: true }]);
    await combat.createEmbeddedDocuments("Combatant", [{ tokenId: toks[1].id, actorId: a1.id }]);
    const rip = [];
    for (let r = 0; r < 4; r++) {
      const sp0 = A.effectiveArmorSP(a1, "Torso"), d0 = Number(a1.system?.damage) || 0;
      const t0 = (a1.getFlag("cp2020-augmented", "dotState") ?? [])[0]?.turnsLeft ?? null;
      await combat.nextTurn();
      for (let i = 0; i < 40; i++) { await sleep(150); if (combat.combatant?.actorId === a1.id) break; }
      if (combat.combatant?.actorId !== a1.id) { await combat.nextTurn(); }
      for (let i = 0; i < 40; i++) { await sleep(150); if (A.effectiveArmorSP(a1, "Torso") !== sp0 || (Number(a1.system?.damage) || 0) !== d0) break; }
      // the marker's flag write is the tick's LAST act (after the damage and the cards): poll for it
      // to move on from what it was before the round, bounded (one red read it mid-tick, 2026-09-19)
      for (let i = 0; i < 40; i++) { const m = (a1.getFlag("cp2020-augmented", "dotState") ?? [])[0] ?? null; if ((m?.turnsLeft ?? null) !== t0) break; await sleep(150); }
      await sleep(200);
      rip.push({ sp: A.effectiveArmorSP(a1, "Torso"), dmg: Number(a1.system?.damage) || 0, marker: !!(a1.getFlag("cp2020-augmented", "dotState") ?? [])[0] });
      if (!rip[rip.length - 1].marker) break;
    }
    out.rip = rip;
    out.btm = Number(a1.system?.stats?.bt?.modifier) || 0;
  } catch (e) { out.threw = String(e?.message ?? e) + " " + String(e?.stack ?? "").split("\n")[1]; }
  finally {
    try { await combat?.delete(); } catch (_e) {}
    for (const t of toks) { try { await t?.delete(); } catch (_e) {} }
    for (const a of made) { try { await a.delete(); } catch (_e) {} }
    await game.settings.set("cp2020-augmented", "mechRoundTickAutomation", tickWas);
    for (const m of game.messages.contents) if (!msgIdsBefore.has(m.id)) await m.delete().catch(() => {});
  }
  return out;
}, { SAVES, APPL });
check("the squirtgun section ran", !squirt.threw, String(squirt.threw ?? ""));
eq("⭐ a blank roll: the hit's own damage is the acid (two pellets rolled 7)", squirt.squirtMarker?.perRound, 7);
eq("NEGATIVE: no damage, no acid, no marker", squirt.zeroMarker, null);
check("a hit that penetrated writes a marker that will not sear", squirt.penMarker?.stoppedByArmor === false, JSON.stringify(squirt.penMarker));
eq("…it eats what armour there is (3 of 5)", squirt.pen?.sp, 0);
eq("…and nothing more reaches the body", squirt.pen?.dmg, 0);
eq("…and keeps counting down rather than being spent", squirt.pen?.marker?.turnsLeft, 2);
check("⭐ THE BOOK'S OWN EXAMPLE: SP 15, acid 7 — 8, then 1, then 6 sear through and it is over",
  Array.isArray(squirt.rip) && squirt.rip.length === 3 && squirt.rip[0].sp === 8 && squirt.rip[1].sp === 1
  && squirt.rip[2].sp === 0 && squirt.rip[2].dmg === Math.max(1, 6 - squirt.btm) && squirt.rip[2].marker === false,
  JSON.stringify(squirt.rip) + ` btm ${squirt.btm}`);

/* ─────────────────── §6 fire, two rows, the old marker ─────────────────── */
console.log("\n§6 fire rows, two rows together, a marker from before");
const more = await page.evaluate(async ({ SAVES, APPL }) => {
  const V = await import(SAVES); const A = await import(APPL);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  const scene = game.scenes.viewed ?? game.scenes.active;
  const made = [];
  const cov = (sp) => Object.fromEntries(["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"].map(k => [k, { stoppingPower: sp }]));
  const mk = async (name, sp) => {
    const a = await Actor.create({ name, type: "character" }); made.push(a);
    await a.createEmbeddedDocuments("Item", [{ name: name + " Coat", type: "armor", system: { equipped: true, armorType: "Soft", coverage: cov(sp) } }]);
    return a;
  };
  const msgIdsBefore = new Set(game.messages.contents.map(m => m.id));
  const tickWas = game.settings.get("cp2020-augmented", "mechRoundTickAutomation");
  let combat = null; const toks = [];
  try {
    await game.settings.set("cp2020-augmented", "mechRoundTickAutomation", true);
    const a1 = await mk("__PW__OT Both", 10);
    await V.applyDotFromPayload(a1, "Torso", { overTime: [{ type: "acid", turns: 3, formula: "2", flat: false }, { type: "fire", turns: 2, formula: "1d6", flat: true }] }, true, 5);
    out.both = { acid: (a1.getFlag("cp2020-augmented", "dotState") ?? []).length, fire: (a1.getFlag("cp2020-augmented", "fireDotState") ?? [])[0] ?? null,
      burning: a1.statuses?.has("burning") === true, corrode: a1.statuses?.has("corrode") === true };
    const a2 = await mk("__PW__OT FireOnly", 10);
    await V.applyDotFromPayload(a2, "Torso", { overTime: [{ type: "fire", turns: 2, formula: "", flat: false }] }, false, 5);
    out.fireNotPenetrated = a2.getFlag("cp2020-augmented", "fireDotState") ?? null;
    await V.applyDotFromPayload(a2, "Torso", { overTime: [{ type: "fire", turns: 2, formula: "", flat: false }] }, true, 5);
    out.fireBlankFormula = (a2.getFlag("cp2020-augmented", "fireDotState") ?? [])[0]?.formula ?? null;
    // a marker written before the change: formula only — it is rolled once on its first tick and kept
    const a3 = await mk("__PW__OT Legacy", 20);
    await a3.setFlag("cp2020-augmented", "dotState", [{ location: "Torso", turnsLeft: 3, formula: "3" }]);
    [toks[0]] = await scene.createEmbeddedDocuments("Token", [{ name: a3.name, actorId: a3.id, actorLink: true, x: 1500, y: 1500, hidden: true }]);
    combat = await Combat.create({ scene: scene.id, active: true });
    await combat.createEmbeddedDocuments("Combatant", [{ tokenId: toks[0].id, actorId: a3.id }]);
    await combat.startCombat(); await sleep(300);
    await combat.nextRound();
    for (let i = 0; i < 40; i++) { await sleep(150); if (A.effectiveArmorSP(a3, "Torso") !== 20) break; }
    await sleep(400);
    out.legacy = { sp: A.effectiveArmorSP(a3, "Torso"), dmg: Number(a3.system?.damage) || 0, marker: (a3.getFlag("cp2020-augmented", "dotState") ?? [])[0] ?? null };
  } catch (e) { out.threw = String(e?.message ?? e) + " " + String(e?.stack ?? "").split("\n")[1]; }
  finally {
    try { await combat?.delete(); } catch (_e) {}
    for (const t of toks) { try { await t?.delete(); } catch (_e) {} }
    for (const a of made) { try { await a.delete(); } catch (_e) {} }
    await game.settings.set("cp2020-augmented", "mechRoundTickAutomation", tickWas);
    for (const m of game.messages.contents) if (!msgIdsBefore.has(m.id)) await m.delete().catch(() => {});
  }
  return out;
}, { SAVES, APPL });
check("the fire section ran", !more.threw, String(more.threw ?? ""));
eq("two rows on one hit: one acid marker", more.both?.acid, 1);
check("…and one fire marker, flat as stated", more.both?.fire?.flat === true && more.both?.fire?.turnsLeft === 2, JSON.stringify(more.both?.fire));
check("…both conditions raised", more.both?.burning === true && more.both?.corrode === true);
eq("NEGATIVE: fire on a hit that did not penetrate lights nothing (RAW)", more.fireNotPenetrated, null);
eq("a blank fire roll burns for the incendiary load's own 1d6", more.fireBlankFormula, "1d6");
eq("a marker from before the change: its formula is rolled once and the armour loses it (20 → 17)", more.legacy?.sp, 17);
eq("…the number is kept on the marker from then on", more.legacy?.marker?.perRound, 3);
eq("…and it counts down", more.legacy?.marker?.turnsLeft, 2);
eq("…and never sears (its hit resolved the old way)", more.legacy?.dmg, 0);

/* ─────────────────── §7 the sheet ─────────────────── */
console.log("\n§7 the weapon sheet — real clicks");
const sheet = await page.evaluate(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  let w = null, app = null;
  const rowsOf = () => (w._source.system.overTime ?? []).map(r => [r.type, r.turns, r.formula, r.flat]);
  const waitRows = async (n) => { for (let i = 0; i < 40; i++) { if ((w._source.system.overTime ?? []).length === n) return true; await sleep(100); } return false; };
  try {
    w = await Item.create({ name: "__PW__OT Sheet Blade", type: "weapon", system: { weaponType: "melee", damage: "4d6" } });
    app = w.sheet; await app.render(true);
    let root = null; for (let i = 0; i < 40 && !root; i++) { root = app.element?.querySelector?.(".cp-weapon-overtime") ?? null; await sleep(100); }
    out.blockRendered = !!root;
    out.noRawKeys = !/CYBERPUNK\./.test(root?.textContent ?? "CYBERPUNK.");
    out.rowsBefore = root?.querySelectorAll(".cp-ot-row").length ?? -1;
    root?.querySelector(".cp-ot-add")?.click();
    out.addedPersisted = await waitRows(1);
    await sleep(500);
    out.afterAdd = rowsOf();
    root = app.element.querySelector(".cp-weapon-overtime");
    out.rowRendered = root?.querySelectorAll(".cp-ot-row").length ?? -1;
    // choose fire: the row is re-seeded with fire's numbers
    const sel = root?.querySelector("select.cp-ot-type");
    if (sel) { sel.value = "fire"; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    for (let i = 0; i < 40; i++) { if (w._source.system.overTime?.[0]?.type === "fire") break; await sleep(100); }
    await sleep(500);
    out.afterType = rowsOf();
    // type a number of rounds: the sheet's own submit writes it, the other columns untouched
    root = app.element.querySelector(".cp-weapon-overtime");
    const turns = root?.querySelector("input.cp-ot-turns");
    if (turns) { turns.value = "5"; turns.dispatchEvent(new Event("change", { bubbles: true })); }
    for (let i = 0; i < 40; i++) { if (w._source.system.overTime?.[0]?.turns === 5) break; await sleep(100); }
    await sleep(500);
    out.afterTurns = rowsOf();
    // a second row, then remove the first: the second survives with its values
    root = app.element.querySelector(".cp-weapon-overtime");
    root?.querySelector(".cp-ot-add")?.click();
    await waitRows(2); await sleep(500);
    root = app.element.querySelector(".cp-weapon-overtime");
    root?.querySelector('.cp-ot-remove[data-index="0"]')?.click();
    out.removedPersisted = await waitRows(1);
    await sleep(300);
    out.afterRemove = rowsOf();
  } catch (e) { out.threw = String(e?.message ?? e) + " " + String(e?.stack ?? "").split("\n")[1]; }
  finally {
    try { await app?.close(); } catch (_e) {}
    for (const it of game.items.filter(i => /^__PW__OT/.test(i.name))) await it.delete().catch(() => {});
  }
  return out;
});
check("the sheet section ran", !sheet.threw, String(sheet.threw ?? ""));
check("the block renders on a weapon sheet", sheet.blockRendered === true);
check("every visible string is localized", sheet.noRawKeys === true);
eq("no rows on a weapon that has none", sheet.rowsBefore, 0);
check("+ Add writes one row, seeded as acid, 3 rounds, the weapon's own roll", sheet.addedPersisted === true && JSON.stringify(sheet.afterAdd) === JSON.stringify([["acid", 3, "", false]]), JSON.stringify(sheet.afterAdd));
eq("and the row renders", sheet.rowRendered, 1);
eq("choosing fire re-seeds the row with fire's own figures", sheet.afterType, [["fire", 2, "1d6", false]]);
eq("a typed number of rounds persists through the sheet's own submit, the rest untouched", sheet.afterTurns, [["fire", 5, "1d6", false]]);
check("removing the first of two leaves the second, seeded, in place", sheet.removedPersisted === true && JSON.stringify(sheet.afterRemove) === JSON.stringify([["acid", 3, "", false]]), JSON.stringify(sheet.afterRemove));

/* ─────────────────── §8 ─────────────────── */
console.log("\n§8 client health");
eq("0 console errors", errors.slice(0, 4), []);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
