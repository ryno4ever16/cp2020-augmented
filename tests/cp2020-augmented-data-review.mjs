/**
 * Keeper — the out-of-enum select rewrite (2026-09-19): the spelling repair, the suspect notice, and
 * the selects that no longer lie.
 *
 *  §1 pure: the canonical spelling map, the per-item update, the version gate, the suspect rows
 *  §2 the migration, live: every recognised spelling on weapons and cyberweapons — on world actors,
 *     an unlinked token's actor and a world item — is canonicalised; enum values untouched; idempotent
 *  §3 the notice, live: rows in, one GM-whispered card out with the names on it; no rows, no card
 *  §4 the selects: an out-of-enum stored value renders BLANK, not as the first option, and a submit
 *     no longer writes the first option
 *  §5 client health
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
const MOD = "/modules/cp2020-augmented/module/data-review.js";

/* ─────────────────── §1 pure ─────────────────── */
console.log("\n§1 pure");
const pure = await page.evaluate(async (MOD) => {
  const M = await import(MOD);
  const packs = new Map([["budgetarmsc13", { reliability: "Standard", attackType: "", concealability: "ConcealPocket" }],
                         ["uziminiauto9", { reliability: "VeryReliable", attackType: "Auto", concealability: "ConcealJacket" }]]);
  return {
    lower: M.canonicalReliability("standard"), spaced: M.canonicalReliability("very reliable"), abbr: [M.canonicalReliability("VR"), M.canonicalReliability("st"), M.canonicalReliability("UR")],
    enumSelf: M.canonicalReliability("Unreliable"), junk: M.canonicalReliability("sometimes"), blank: M.canonicalReliability(""),
    updWeapon: M.reliabilitySpellingUpdate({ id: "w1", type: "weapon", system: { reliability: "standard" } }),
    updWeaponOk: M.reliabilitySpellingUpdate({ id: "w2", type: "weapon", system: { reliability: "Standard" } }),
    updCyber: M.reliabilitySpellingUpdate({ id: "c1", type: "cyberware", system: { CyberWorkType: { Weapon: { reliability: "vr" } } } }),
    updCyberNone: M.reliabilitySpellingUpdate({ id: "c2", type: "cyberware", system: { CyberWorkType: { Weapon: { reliability: "" } } } }),
    updArmor: M.reliabilitySpellingUpdate({ id: "a1", type: "armor", system: { reliability: "standard" } }),
    old: M.predatesCorrectedPacks({ systemVersion: "1.0.3" }), missing: M.predatesCorrectedPacks({}), fixed: M.predatesCorrectedPacks({ systemVersion: "1.1.0" }), current: M.predatesCorrectedPacks({ systemVersion: "1.1.1" }),
    key: M.nameKey(" Budget Arms C13 "), key2: M.nameKey("BudgetArms C-13"),
    rows: M.suspectWeaponRows([
      { actorName: "Bartz", itemName: "Budget Arms C13", stats: { systemVersion: "1.0.3" }, system: { reliability: "VeryReliable", attackType: "Auto", concealability: "ConcealPocket" } },
      { actorName: "Wade", itemName: "Uzi Miniauto 9", stats: { systemVersion: "1.0.3" }, system: { reliability: "very reliable", attackType: "Auto", concealability: "ConcealJacket" } },
      { actorName: "Fresh", itemName: "Budget Arms C13", stats: { systemVersion: "1.1.1" }, system: { reliability: "VeryReliable", attackType: "Auto", concealability: "ConcealPocket" } },
      { actorName: "Homebrew", itemName: "Acid Bat", stats: { systemVersion: "1.0.3" }, system: { reliability: "VeryReliable" } },
    ], packs),
  };
}, MOD);
eq("lower-case standard → Standard", pure.lower, "Standard");
eq("'very reliable' → VeryReliable", pure.spaced, "VeryReliable");
eq("the book's abbreviations resolve", pure.abbr, ["VeryReliable", "Standard", "Unreliable"]);
eq("an enum value answers itself", pure.enumSelf, "Unreliable");
eq("NEGATIVE: an unknown spelling is null — never guessed", pure.junk, null);
eq("NEGATIVE: blank is null", pure.blank, null);
eq("a weapon with a bad spelling gets its update", pure.updWeapon, { _id: "w1", "system.reliability": "Standard" });
eq("NEGATIVE: a weapon already in the enum gets none", pure.updWeaponOk, null);
eq("a cyberweapon work-block is repaired on its own path", pure.updCyber, { _id: "c1", "system.CyberWorkType.Weapon.reliability": "VeryReliable" });
eq("NEGATIVE: a blank cyberweapon field is left alone", pure.updCyberNone, null);
eq("NEGATIVE: an armor item is not a weapon", pure.updArmor, null);
eq("the version gate: 1.0.3 predates the corrected packs; a missing stamp does too", [pure.old, pure.missing], [true, true]);
eq("…1.1.0 and 1.1.1 do not", [pure.fixed, pure.current], [false, false]);
eq("names key the same with or without spaces and hyphens", [pure.key, pure.key2], ["budgetarmsc13", "budgetarmsc13"]);
eq("suspect rows: the old C13 disagrees on reliability only (blank pack attack type is no disagreement; concealability agrees)",
  pure.rows.filter(r => r.actorName === "Bartz").map(r => [r.field, r.stored, r.pack]), [["Reliability", "VeryReliable", "Standard"]]);
eq("…reliability compares by canonical spelling (very reliable = VeryReliable), so the old Uzi is clean", pure.rows.filter(r => r.actorName === "Wade").length, 0);
eq("NEGATIVE: an item written by the corrected build is never a suspect", pure.rows.filter(r => r.actorName === "Fresh").length, 0);
eq("NEGATIVE: a weapon with no compendium namesake is never a suspect", pure.rows.filter(r => r.actorName === "Homebrew").length, 0);

/* ─────────────────── §2 the migration, live ─────────────────── */
console.log("\n§2 the migration, live");
const mig = await page.evaluate(async (MOD) => {
  const M = await import(MOD);
  const out = {};
  const SCOPE = "cp2020-augmented";
  const scene = game.scenes.viewed ?? game.scenes.active;
  let a = null, tok = null, wi = null;
  const stamps = { d: null, c: null };
  try {
    for (const k of ["reliabilitySpellingMigrated", "reliabilitySpellingMigratedCompleted"]) {
      if (game.settings.settings.has(`${SCOPE}.${k}`)) { stamps[k] = game.settings.get(SCOPE, k); }
    }
    a = await Actor.create({ name: "__PW__DR Bearer", type: "character" });
    await a.createEmbeddedDocuments("Item", [
      { name: "__PW__DR Lower", type: "weapon", system: { weaponType: "Pistol", reliability: "standard" } },
      { name: "__PW__DR Spaced", type: "weapon", system: { weaponType: "Pistol", reliability: "very reliable" } },
      { name: "__PW__DR Abbr", type: "weapon", system: { weaponType: "Pistol", reliability: "UR" } },
      { name: "__PW__DR Good", type: "weapon", system: { weaponType: "Pistol", reliability: "Unreliable" } },
      { name: "__PW__DR Junk", type: "weapon", system: { weaponType: "Pistol", reliability: "sometimes" } },
      { name: "__PW__DR Cyber", type: "cyberware", system: { CyberWorkType: { Type: "Weapon", Weapon: { reliability: "st" } } } },
    ]);
    // an UNLINKED token's own actor delta
    [tok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__DR Unlinked", actorId: a.id, actorLink: false, x: 1400, y: 1400, hidden: true }]);
    const lowerId = a.items.find(i => i.name === "__PW__DR Lower").id;
    await tok.actor.updateEmbeddedDocuments("Item", [{ _id: lowerId, "system.reliability": "very reliable" }]);
    wi = await Item.create({ name: "__PW__DR World", type: "weapon", system: { weaponType: "Pistol", reliability: "vr" } });
    const r1 = await M.migrateReliabilitySpelling({ force: true });
    const rel = (n) => a.items.find(i => i.name === n)?._source?.system?.reliability;
    out.first = r1;
    out.after = { lower: rel("__PW__DR Lower"), spaced: rel("__PW__DR Spaced"), abbr: rel("__PW__DR Abbr"), good: rel("__PW__DR Good"), junk: rel("__PW__DR Junk"),
      cyber: a.items.find(i => i.name === "__PW__DR Cyber")?._source?.system?.CyberWorkType?.Weapon?.reliability,
      unlinked: tok.actor.items.get(lowerId)?._source?.system?.reliability, world: wi._source.system.reliability };
    const r2 = await M.migrateReliabilitySpelling({ force: true });
    out.second = r2;
    out.stamps = [game.settings.get(SCOPE, "reliabilitySpellingMigrated"), game.settings.get(SCOPE, "reliabilitySpellingMigratedCompleted")];
    out.gated = (await M.migrateReliabilitySpelling()).skipped;
  } catch (e) { out.threw = String(e?.message ?? e) + " " + String(e?.stack ?? "").split("\n")[1]; }
  finally {
    try { await tok?.delete(); } catch (_e) {}
    try { await a?.delete(); } catch (_e) {}
    try { await wi?.delete(); } catch (_e) {}
  }
  return out;
}, MOD);
check("the migration section ran", !mig.threw, String(mig.threw ?? ""));
eq("lower-case standard is canonicalised on a world actor", mig.after?.lower, "Standard");
eq("'very reliable' too", mig.after?.spaced, "VeryReliable");
eq("and the book's abbreviation", mig.after?.abbr, "Unreliable");
eq("NEGATIVE: an enum value is untouched", mig.after?.good, "Unreliable");
eq("NEGATIVE: an unrecognised spelling is left as it is — never guessed", mig.after?.junk, "sometimes");
eq("a cyberweapon work-block is repaired", mig.after?.cyber, "Standard");
eq("an UNLINKED token's own copy is repaired", mig.after?.unlinked, "VeryReliable");
eq("a world item is repaired", mig.after?.world, "VeryReliable");
// The rig's own world carries pre-corrected items of its own (62 on the first run, 2026-09-19 — the
// -add packs' spellings dragged onto fixtures over the months), so the count is a floor: at least the
// fixture's five embedded and one world item, and the values above prove they were among them.
check("the first pass counts what it changed (at least the fixture's 5 embedded across 2 actors and 1 world item)",
  mig.first?.items >= 5 && mig.first?.actors >= 2 && mig.first?.worldItems >= 1, JSON.stringify(mig.first));
check("the second pass changes nothing — idempotent", mig.second?.items === 0 && mig.second?.worldItems === 0, JSON.stringify(mig.second));
eq("both stamps are set", mig.stamps, [true, true]);
eq("and an unforced call is gated off by them", mig.gated, "done");

/* ─────────────────── §3 the notice, live ─────────────────── */
console.log("\n§3 the notice, live");
const notice = await page.evaluate(async (MOD) => {
  const M = await import(MOD);
  const out = {};
  const before = new Set(game.messages.contents.map(m => m.id));
  try {
    const packByKey = new Map([["budgetarmsc13", { reliability: "Standard", attackType: "", concealability: "ConcealPocket" }]]);
    const r = await M.reviewSuspectWeapons({ force: true, packByKey, weapons: [
      { actorName: "__PW__DR Bartz", itemName: "Budget Arms C13", stats: { systemVersion: "1.0.3" }, system: { reliability: "VeryReliable", attackType: "Auto", concealability: "ConcealPocket" } },
    ] });
    out.rows = r.rows; out.posted = r.posted;
    await new Promise(res => setTimeout(res, 400));
    const fresh = game.messages.contents.filter(m => !before.has(m.id));
    out.cards = fresh.length;
    out.whispered = fresh.every(m => (m.whisper ?? []).length > 0 && (m.whisper ?? []).every(u => game.users.get(u)?.isGM));
    out.namesOnCard = fresh.some(m => /__PW__DR Bartz/.test(m.content) && /Budget Arms C13/.test(m.content) && /VeryReliable/.test(m.content) && /Standard/.test(m.content));
    out.noRawKeys = fresh.every(m => !/CYBERPUNK\./.test(m.content));
    for (const m of fresh) await m.delete().catch(() => {});
    const before2 = new Set(game.messages.contents.map(m => m.id));
    const r2 = await M.reviewSuspectWeapons({ force: true, packByKey, weapons: [
      { actorName: "__PW__DR Clean", itemName: "Budget Arms C13", stats: { systemVersion: "1.1.1" }, system: { reliability: "Standard", attackType: "", concealability: "ConcealPocket" } },
    ] });
    await new Promise(res => setTimeout(res, 300));
    out.cleanRows = r2.rows.length; out.cleanPosted = r2.posted;
    out.cleanCards = game.messages.contents.filter(m => !before2.has(m.id)).length;
    out.stamp = game.settings.get("cp2020-augmented", "weaponReviewNoticePosted");
    out.gated = (await M.reviewSuspectWeapons()).skipped;
    out.realWorld = (await M.reviewSuspectWeapons({ force: true })).rows.length;
    for (const m of game.messages.contents.filter(m => !before.has(m.id))) await m.delete().catch(() => {});
  } catch (e) { out.threw = String(e?.message ?? e) + " " + String(e?.stack ?? "").split("\n")[1]; }
  return out;
}, MOD);
check("the notice section ran", !notice.threw, String(notice.threw ?? ""));
eq("one suspect row for the old C13", notice.rows?.length, 1);
check("one card posted", notice.posted === true && notice.cards === 1, `${notice.cards} card(s)`);
check("whispered to the GM only", notice.whispered === true);
check("the actor, the weapon, the stored value and the compendium value are on it", notice.namesOnCard === true);
check("every visible string is localized", notice.noRawKeys === true);
check("NEGATIVE: no suspects, no card", notice.cleanRows === 0 && notice.cleanPosted === false && notice.cleanCards === 0, JSON.stringify([notice.cleanRows, notice.cleanPosted, notice.cleanCards]));
eq("the stamp is set and gates an unforced call", [notice.stamp, notice.gated], [true, "done"]);
eq("the rig's own world (all current-build items) has no suspects", notice.realWorld, 0);

/* ─────────────────── §4 the selects ─────────────────── */
console.log("\n§4 the selects no longer lie");
const sel = await page.evaluate(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  let w = null, c = null;
  try {
    w = await Item.create({ name: "__PW__DR Select", type: "weapon", system: { weaponType: "melee", reliability: "sometimes", cost: 1 } });
    await w.sheet.render(true);
    let root = null; for (let i = 0; i < 40 && !root; i++) { root = w.sheet.element?.querySelector?.('select[name="system.reliability"]') ? w.sheet.element : null; await sleep(100); }
    const rel = root.querySelector('select[name="system.reliability"]'), wt = root.querySelector('select[name="system.weaponType"]');
    out.relShown = rel?.value; out.wtShown = wt?.value;
    out.relFirst = rel?.options?.[0]?.value; out.hasBlank = rel?.options?.[0]?.value === "";
    // a submit through another field: the first option is NOT written
    const cost = root.querySelector('input[name="system.cost"]');
    if (cost) { cost.value = "2"; cost.dispatchEvent(new Event("change", { bubbles: true })); }
    for (let i = 0; i < 30; i++) { await sleep(100); if (w._source.system.cost === 2) break; }
    await sleep(300);
    out.relStoredAfterSubmit = w._source.system.reliability; out.wtStoredAfterSubmit = w._source.system.weaponType; out.costStored = w._source.system.cost;
    await w.sheet.close();
    c = await Item.create({ name: "__PW__DR CyberSel", type: "cyberware", system: { CyberWorkType: { Type: "Weapon", Weapon: { reliability: "st", weaponType: "pistol" } } } });
    await c.sheet.render(true);
    let croot = null; for (let i = 0; i < 40 && !croot; i++) { croot = c.sheet.element?.querySelector?.('select[name="system.CyberWorkType.Weapon.reliability"]') ? c.sheet.element : null; await sleep(100); }
    out.cyberRelShown = croot?.querySelector('select[name="system.CyberWorkType.Weapon.reliability"]')?.value ?? "(no select)";
    out.cyberWtShown = croot?.querySelector('select[name="system.CyberWorkType.Weapon.weaponType"]')?.value ?? "(no select)";
    await c.sheet.close();
  } catch (e) { out.threw = String(e?.message ?? e) + " " + String(e?.stack ?? "").split("\n")[1]; }
  finally { try { await w?.delete(); } catch (_e) {} try { await c?.delete(); } catch (_e) {} }
  return out;
});
check("the select section ran", !sel.threw, String(sel.threw ?? ""));
eq("an out-of-enum reliability renders BLANK — not the first option", sel.relShown, "");
check("and the first option IS the blank one", sel.hasBlank === true, String(sel.relFirst));
eq("an out-of-enum weapon type renders blank too", sel.wtShown, "");
check("⭐ a submit through another field no longer writes Very Reliable / Exotic over the stored value",
  sel.costStored === 2 && sel.relStoredAfterSubmit !== "VeryReliable" && sel.wtStoredAfterSubmit !== "Exotic",
  JSON.stringify([sel.relStoredAfterSubmit, sel.wtStoredAfterSubmit, sel.costStored]));
eq("the cyberweapon reliability select renders blank for an out-of-enum value", sel.cyberRelShown, "");
eq("and its weapon type", sel.cyberWtShown, "");

console.log("\n§5 client health");
eq("0 console errors", errors.slice(0, 4), []);
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
