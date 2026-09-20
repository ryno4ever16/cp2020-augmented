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
    updWeapon: M.enumSpellingUpdate({ id: "w1", type: "weapon", system: { reliability: "standard" } }),
    updWeaponOk: M.enumSpellingUpdate({ id: "w2", type: "weapon", system: { reliability: "Standard" } }),
    updCyber: M.enumSpellingUpdate({ id: "c1", type: "cyberware", system: { CyberWorkType: { Weapon: { reliability: "vr" } } } }),
    updCyberNone: M.enumSpellingUpdate({ id: "c2", type: "cyberware", system: { CyberWorkType: { Weapon: { reliability: "" } } } }),
    updArmor: M.enumSpellingUpdate({ id: "a1", type: "armor", system: { reliability: "standard" } }),
    // ⭐ the base system's OWN defaults are spellings too: ST / P / common — and the placeholders
    updDefaults: M.enumSpellingUpdate({ id: "w3", type: "weapon", system: { reliability: "ST", concealability: "P", availability: "common" } }),
    updPlaceholder: M.enumSpellingUpdate({ id: "w4", type: "weapon", system: { reliability: "Standard", concealability: "long coat", availability: "undefined" } }),
    updSourceWins: M.enumSpellingUpdate({ id: "w5", type: "weapon", _source: { system: { reliability: "ST" } }, system: { reliability: "Standard" } }),
    old: M.predatesCorrectedPacks({ systemVersion: "1.0.3", createdTime: 1 }), missing: M.predatesCorrectedPacks({}),
    fixed: M.predatesCorrectedPacks({ systemVersion: "1.1.0", createdTime: 1 }), current: M.predatesCorrectedPacks({ systemVersion: "1.1.1", createdTime: 1 }),
    editedOld: M.predatesCorrectedPacks({ systemVersion: "1.1.1" }),
    key: M.nameKey(" Budget Arms C13 "), key2: M.nameKey("BudgetArms C-13"), keySuffix: M.nameKey("Sternmeyer Type 35 (left)"),
    rows: M.suspectWeaponRows([
      { actorName: "Bartz", itemName: "Budget Arms C13", uuid: "Actor.a.Item.b", stats: { systemVersion: "1.0.3" }, system: { reliability: "VeryReliable", attackType: "Auto", concealability: "ConcealPocket" } },
      { actorName: "Wade", itemName: "Uzi Miniauto 9", stats: { systemVersion: "1.0.3" }, system: { reliability: "very reliable", attackType: "Auto", concealability: "ConcealJacket" } },
      { actorName: "Fresh", itemName: "Budget Arms C13", stats: { systemVersion: "1.1.1", createdTime: 1 }, system: { reliability: "VeryReliable", attackType: "Auto", concealability: "ConcealPocket" } },
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
eq("the base defaults ST / P / common are read as Standard / Pocket / Common", pure.updDefaults, { _id: "w3", "system.reliability": "Standard", "system.concealability": "ConcealPocket", "system.availability": "Common" });
eq("'long coat' and the undefined placeholder are read as Longcoat and blank", pure.updPlaceholder, { _id: "w4", "system.concealability": "ConcealLongcoat", "system.availability": "" });
eq("the update reads the SOURCE, not the prepared value (which the model already canonicalises)", pure.updSourceWins, { _id: "w5", "system.reliability": "Standard" });
eq("the version gate: 1.0.3 predates the corrected packs; a missing stamp does too", [pure.old, pure.missing], [true, true]);
eq("…1.1.0 and 1.1.1 with a creation stamp do not", [pure.fixed, pure.current], [false, false]);
check("⭐ an old item edited under the current build still reads as old — no creation stamp", pure.editedOld === true);
eq("names key the same with or without spaces and hyphens", [pure.key, pure.key2], ["budgetarmsc13", "budgetarmsc13"]);
eq("and a trailing parenthetical (the lorekeeper's '(left)') is dropped", pure.keySuffix, "sternmeyertype35");
eq("suspect rows: the old C13 disagrees on reliability only (blank pack attack type is no disagreement; concealability agrees)",
  pure.rows.filter(r => r.actorName === "Bartz").map(r => [r.field, r.fieldLabel, r.stored, r.pack, r.uuid]), [["reliability", "Reliability", "VeryReliable", "Standard", "Actor.a.Item.b"]]);
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
    for (const k of ["enumSpellingsMigrated", "enumSpellingsMigratedCompleted"]) {
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
      // ⭐ the base system's own defaults, as every weapon created from scratch starts
      { name: "__PW__DR Defaults", type: "weapon", system: { weaponType: "Pistol", reliability: "ST", concealability: "P", availability: "common" } },
      { name: "__PW__DR Placeholder", type: "weapon", system: { weaponType: "Pistol", reliability: "Standard", concealability: "long coat", availability: "undefined" } },
      // ⭐ a weapon created with NONE of the three: the schema's own defaults land in the source
      { name: "__PW__DR Bare", type: "weapon", system: { weaponType: "Pistol" } },
    ]);
    // READ-TIME: explicit creation data is read as the enum on its way in (source and prepared agree);
    // the schema DEFAULTS arrive after that reading and sit in the source as "ST"/"P"/"common" — the
    // prepared model canonicalises them, so the sheet and the math never see the abbreviation
    const dflt = a.items.find(i => i.name === "__PW__DR Defaults"), bare = a.items.find(i => i.name === "__PW__DR Bare");
    const cyb = a.items.find(i => i.name === "__PW__DR Cyber");
    out.cyberPrepared = cyb?.system?.CyberWorkType?.Weapon?.reliability ?? null;
    out.readTime = { prepared: [dflt.system.reliability, dflt.system.concealability, dflt.system.availability],
      source: [dflt._source.system.reliability, dflt._source.system.concealability, dflt._source.system.availability],
      barePrepared: [bare.system.reliability, bare.system.concealability, bare.system.availability],
      bareSource: [bare._source.system.reliability, bare._source.system.concealability, bare._source.system.availability] };
    // an UNLINKED token's own actor delta
    [tok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__DR Unlinked", actorId: a.id, actorLink: false, x: 1400, y: 1400, hidden: true }]);
    const lowerId = a.items.find(i => i.name === "__PW__DR Lower").id;
    await tok.actor.updateEmbeddedDocuments("Item", [{ _id: lowerId, "system.reliability": "very reliable" }]);
    wi = await Item.create({ name: "__PW__DR World", type: "weapon", system: { weaponType: "Pistol", reliability: "vr" } });
    const r1 = await M.migrateEnumSpellings({ force: true });
    const rel = (n) => a.items.find(i => i.name === n)?._source?.system?.reliability;
    out.first = r1;
    out.after = { lower: rel("__PW__DR Lower"), spaced: rel("__PW__DR Spaced"), abbr: rel("__PW__DR Abbr"), good: rel("__PW__DR Good"), junk: rel("__PW__DR Junk"),
      cyber: a.items.find(i => i.name === "__PW__DR Cyber")?._source?.system?.CyberWorkType?.Weapon?.reliability,
      unlinked: tok.actor.items.get(lowerId)?._source?.system?.reliability, world: wi._source.system.reliability };
    const src = (n) => { const it = a.items.find(i => i.name === n); return [it._source.system.reliability, it._source.system.concealability, it._source.system.availability]; };
    out.afterDefaults = src("__PW__DR Defaults"); out.afterPlaceholder = src("__PW__DR Placeholder"); out.afterBare = src("__PW__DR Bare");
    const r2 = await M.migrateEnumSpellings({ force: true });
    out.second = r2;
    out.stamps = [game.settings.get(SCOPE, "enumSpellingsMigrated"), game.settings.get(SCOPE, "enumSpellingsMigratedCompleted")];
    out.gated = (await M.migrateEnumSpellings()).skipped;
  } catch (e) { out.threw = String(e?.message ?? e) + " " + String(e?.stack ?? "").split("\n")[1]; }
  finally {
    try { await tok?.delete(); } catch (_e) {}
    try { await a?.delete(); } catch (_e) {}
    try { await wi?.delete(); } catch (_e) {}
  }
  return out;
}, MOD);
check("the migration section ran", !mig.threw, String(mig.threw ?? ""));
eq("⭐ READ-TIME: explicit ST / P / common are read as Standard / Pocket / Common on the prepared document", mig.readTime?.prepared, ["Standard", "ConcealPocket", "Common"]);
eq("…and the same reading is what the document keeps as its source (creation data is read on its way in)", mig.readTime?.source, ["Standard", "ConcealPocket", "Common"]);
eq("⭐ a weapon created with NONE of the three shows Standard / Pocket / Common — the schema defaults, read", mig.readTime?.barePrepared, ["Standard", "ConcealPocket", "Common"]);
eq("…while its stored source holds the base system's own ST / P / common (defaults arrive after the reading)", mig.readTime?.bareSource, ["ST", "P", "common"]);
eq("the migration PERSISTS the reading on the bare weapon", mig.afterBare, ["Standard", "ConcealPocket", "Common"]);
eq("a cyberweapon work-block's 'st' reads as Standard on the prepared document too", mig.cyberPrepared, "Standard");
eq("and leaves the explicitly created one as it already was", mig.afterDefaults, ["Standard", "ConcealPocket", "Common"]);
eq("…and turns 'long coat' / the undefined placeholder into Longcoat / blank", mig.afterPlaceholder, ["Standard", "ConcealLongcoat", ""]);
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
// Explicit creation data is canonical on arrival, so the first pass changes the defaults-born rows
// (Lower's P/common, Bare's three, Placeholder's long coat/undefined) and the cyberweapon: a floor of 4.
check("the first pass counts what it changed (at least the fixture's default-born rows and the cyberweapon; the world item)",
  mig.first?.items >= 4 && mig.first?.actors >= 1 && mig.first?.worldItems >= 1, JSON.stringify(mig.first));
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
    // ⭐ NOT ONCE-EVER (user ruling 2026-09-19): an UNFORCED call posts while rows remain and the GM has
    // not dismissed; a second unforced call REPLACES the standing card (one card, not a stack); the
    // dismiss button stamps the dismissal and takes the card down; after it, unforced is skipped and
    // force still posts.
    await game.settings.set("cp2020-augmented", "weaponReviewDismissed", false);
    const sleepA = (ms) => new Promise(r => setTimeout(r, ms));
    const sus = [{ actorName: "__PW__DR Bartz", itemName: "Budget Arms C13", stats: { systemVersion: "1.0.3" }, system: { reliability: "VeryReliable", attackType: "Auto", concealability: "ConcealPocket" } }];
    const beforeU = new Set(game.messages.contents.map(m => m.id));
    const u1 = await M.reviewSuspectWeapons({ packByKey, weapons: sus });
    await sleepA(400);
    out.unforcedPosted = u1.posted === true && u1.skipped === null;
    const firstId = game.settings.get("cp2020-augmented", "weaponReviewMessageId");
    out.cardIdKept = !!firstId && !!game.messages.get(firstId);
    const u2 = await M.reviewSuspectWeapons({ packByKey, weapons: sus });
    await sleepA(400);
    out.secondReplaces = u2.posted === true && !game.messages.get(firstId) && game.messages.contents.filter(m => !beforeU.has(m.id) && /cp-data-review/.test(m.content)).length === 1;
    let dbtn = null;
    for (let i = 0; i < 40 && !dbtn; i++) { dbtn = document.querySelector(".chat-message .cp-data-review .cp-data-review-dismiss"); if (!dbtn) await sleepA(100); }
    out.dismissRendered = !!dbtn;
    dbtn?.click();
    // wait for the CARD to be gone (the button's last act), not for the stamp (its first) — polling the
    // stamp let the next call race the button's own delete and the server logged a second delete
    const isCard = (m) => !beforeU.has(m.id) && /cp-data-review/.test(m.content);
    for (let i = 0; i < 60; i++) { await sleepA(100); if (!game.messages.contents.some(isCard) && !game.settings.get("cp2020-augmented", "weaponReviewMessageId")) break; }
    await sleepA(300);
    out.dismissed = game.settings.get("cp2020-augmented", "weaponReviewDismissed");
    out.cardGone = game.messages.contents.filter(m => !beforeU.has(m.id) && /cp-data-review/.test(m.content)).length === 0;
    out.gated = (await M.reviewSuspectWeapons({ packByKey, weapons: sus })).skipped;
    // two forced sweeps in flight together: serialised, so exactly ONE card stands afterwards
    const beforeC = new Set(game.messages.contents.map(m => m.id));
    await Promise.all([M.reviewSuspectWeapons({ force: true, packByKey, weapons: sus }), M.reviewSuspectWeapons({ force: true, packByKey, weapons: sus })]);
    await sleepA(500);
    out.concurrentCards = game.messages.contents.filter(m => !beforeC.has(m.id) && /cp-data-review/.test(m.content)).length;
    out.forcedAfter = (await M.reviewSuspectWeapons({ force: true, packByKey, weapons: sus })).posted;
    await sleepA(300);
    out.realWorld = (await M.reviewSuspectWeapons({ force: true })).rows.length;
    // ⭐ COST GATE (server-impact audit 2026-09-19): over a world with no pre-correction weapon the sweep
    // reads NO pack index at all — the field-projected getIndex makes the server read pack documents
    const CC = foundry.documents?.collections?.CompendiumCollection ?? globalThis.CompendiumCollection;
    const origIdx = CC.prototype.getIndex; let idxCalls = 0;
    CC.prototype.getIndex = function (...a) { idxCalls++; return origIdx.apply(this, a); };
    try { await M.reviewSuspectWeapons({ force: true }); } finally { CC.prototype.getIndex = origIdx; }
    out.cleanWorldIndexReads = idxCalls;
    // ⭐ THE SETTINGS-MENU BUTTON (user, 2026-09-20): registered, GM-only, and its render IS the action —
    // over the rig's clean world it says so; over a suspect it posts (the seam cannot reach a menu render,
    // so the posting half is the forced-call legs above; this pins the wiring and the empty answer)
    const menu = game.settings.menus.get("cp2020-augmented.dataReviewMenu");
    out.menu = menu ? { restricted: menu.restricted === true, type: menu.type?.name, label: game.i18n.localize(menu.label) } : null;
    const infos = []; const origInfo = ui.notifications.info;
    ui.notifications.info = (m, ...a) => { infos.push(String(m)); return origInfo.call(ui.notifications, m, ...a); };
    try { if (menu) await new menu.type().render(true); } finally { ui.notifications.info = origInfo; }
    out.menuSaidNothing = infos.some(m => /needs a second look/.test(m));
    out.menuCards = game.messages.contents.filter(m => !before.has(m.id) && /cp-data-review/.test(m.content)).length;
    for (const m of game.messages.contents.filter(m => !before.has(m.id))) await m.delete().catch(() => {});
    await game.settings.set("cp2020-augmented", "weaponReviewDismissed", false);
    await game.settings.set("cp2020-augmented", "weaponReviewMessageId", "");

    /* ⭐ THE GM'S HAND: a card over two REAL weapons; press one Apply, the other row is untouched; then Apply all */
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // Apply ASKS FIRST (2026-09-20): find the confirm dialog, read its text, tick "don't ask again" when told, press yes
    const answerConfirm = async ({ noAsk = false, yes = true } = {}) => {
      for (let i = 0; i < 60; i++) {
        const d = [...foundry.applications.instances.values()].find(a => a.rendered && a.options?.classes?.includes?.("cp-data-review-confirm"));
        if (d) {
          const text = d.element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
          const box = d.element?.querySelector?.('input[name="noask"]');
          if (noAsk && box) box.checked = true;
          d.element?.querySelector?.(yes ? 'button[data-action="yes"]' : 'button[data-action="no"]')?.click();
          return { seen: true, text, hadNoAsk: !!box };
        }
        await sleep(100);
      }
      return { seen: false, text: "", hadNoAsk: false };
    };
    let act = null;
    try {
      act = await Actor.create({ name: "__PW__DR Owner", type: "character" });
      const [w1, w2] = (await act.createEmbeddedDocuments("Item", [
        { name: "__PW__DR Suspect One", type: "weapon", system: { weaponType: "Pistol", reliability: "VeryReliable", attackType: "Auto", concealability: "ConcealPocket" } },
        { name: "__PW__DR Suspect Two", type: "weapon", system: { weaponType: "Pistol", reliability: "VeryReliable", attackType: "", concealability: "ConcealPocket" } },
      ])).sort((x, y) => x.name.localeCompare(y.name));
      const packs = new Map([["pwdrsuspectone", { source: "Pistols (test pack)", reliability: "Standard", attackType: "", concealability: "ConcealJacket" }], ["pwdrsuspecttwo", { source: "Pistols (test pack)", reliability: "Standard", attackType: "", concealability: "ConcealJacket" }]]);
      const rows = [
        { actorName: act.name, itemName: w1.name, uuid: w1.uuid, stats: { systemVersion: "1.0.3" }, system: w1._source.system },
        { actorName: act.name, itemName: w2.name, uuid: w2.uuid, stats: { systemVersion: "1.0.3" }, system: w2._source.system },
      ];
      const before3 = new Set(game.messages.contents.map(m => m.id));
      const r3 = await M.reviewSuspectWeapons({ force: true, packByKey: packs, weapons: rows });
      out.liveRows = r3.rows.length;   // 2 per weapon: reliability + concealability
      let card = null;
      for (let i = 0; i < 40 && !card; i++) { card = document.querySelector("#chat-log .cp-data-review, #chat .cp-data-review, .chat-message .cp-data-review"); if (!card) await sleep(100); }
      out.cardRendered = !!card;
      const btn1 = card?.querySelector(`.cp-data-review-apply[data-uuid="${w1.uuid}"][data-field="reliability"]`);
      out.buttonCarriesValue = btn1?.dataset?.value ?? null;
      out.rowNamesSource = btn1?.closest(".cp-data-review-row")?.querySelector(".cp-data-review-source")?.textContent?.trim() ?? null;
      btn1?.click();
      out.declined = await answerConfirm({ yes: false });
      await sleep(400);
      out.afterDecline = { rel: w1._source.system.reliability, btnEnabled: btn1?.disabled === false };
      btn1?.click();
      out.confirmOne = await answerConfirm({ noAsk: true });
      for (let i = 0; i < 40; i++) { await sleep(100); if (w1._source.system.reliability === "Standard") break; }
      out.afterOne = { one: [w1._source.system.reliability, w1._source.system.concealability], two: [w2._source.system.reliability, w2._source.system.concealability], btnDisabled: btn1?.disabled === true, rowDone: !!btn1?.closest(".cp-data-review-row")?.classList.contains("cp-data-review-done") };
      const btnW1Conceal = card?.querySelector(`.cp-data-review-apply[data-uuid="${w1.uuid}"][data-field="concealability"]`);
      btnW1Conceal?.click();
      const secondAsk = await (async () => { for (let i = 0; i < 8; i++) { const d = [...foundry.applications.instances.values()].find(a => a.rendered && a.options?.classes?.includes?.("cp-data-review-confirm")); if (d) return true; await sleep(100); } return false; })();
      out.secondAsked = secondAsk;
      for (let i = 0; i < 40; i++) { await sleep(100); if (w1._source.system.concealability === "ConcealJacket") break; }
      out.afterSecondSingle = w1._source.system.concealability;
      card?.querySelector(".cp-data-review-apply-all")?.click();
      out.confirmAll = await answerConfirm();
      for (let i = 0; i < 60; i++) { await sleep(100); if (w2._source.system.concealability === "ConcealJacket" && w1._source.system.concealability === "ConcealJacket") break; }
      out.afterAll = { one: [w1._source.system.reliability, w1._source.system.concealability], two: [w2._source.system.reliability, w2._source.system.concealability] };
      // non-GM refusal at the action layer
      const realIsGM = Object.getOwnPropertyDescriptor(game.user, "isGM");
      Object.defineProperty(game.user, "isGM", { value: false, configurable: true });
      try { out.refused = await M.applySuspectValue({ uuid: w1.uuid, field: "reliability", value: "Unreliable" }); }
      finally { if (realIsGM) Object.defineProperty(game.user, "isGM", realIsGM); else Object.defineProperty(game.user, "isGM", { value: true, configurable: true }); }
      out.refusedLeft = w1._source.system.reliability;
      out.badField = await M.applySuspectValue({ uuid: w1.uuid, field: "damage", value: "9d6" });
      // SKILLS ARE NOT REVIEWED, AND HERE IS WHY (2026-09-20): the base 1.1.1 skill model's own migrateData
      // rewrites a blank stat to "cool" on read, so a special ability's blank never reaches a sheet and an
      // Apply could never restore it. The per-type machinery stays; no skill field is declared.
      const [sk] = await act.createEmbeddedDocuments("Item", [{ name: "__PW__DR Credibility", type: "skill", system: { stat: "", level: 3 } }]);
      out.blankStatReadsAs = sk.system.stat;
      const skillPacks = new Map([["skill:pwdrcredibility", { stat: "" }], ["weapon:pwdrcredibility", { reliability: "Standard" }]]);
      out.skillRows = M.suspectWeaponRows([{ type: "skill", actorName: act.name, actorUuid: act.uuid, itemName: sk.name, uuid: sk.uuid, stats: { systemVersion: "1.0.3" }, system: { stat: "int" } }], skillPacks).length;
      out.skillRefusesWeaponField = (await M.applySuspectValue({ uuid: sk.uuid, field: "reliability", value: "Standard" })).skipped;
      out.skillRefusesStat = (await M.applySuspectValue({ uuid: sk.uuid, field: "stat", value: "" })).skipped;
      // the type-qualified pack key: a weapon of a skill's name does not answer for it, and vice versa
      out.typedKeyRows = M.suspectWeaponRows([{ type: "weapon", actorName: act.name, itemName: w1.name, uuid: w1.uuid, stats: { systemVersion: "1.0.3" }, system: { reliability: "VeryReliable" } }],
        new Map([["weapon:pwdrsuspectone", { reliability: "Standard" }], ["skill:pwdrsuspectone", { stat: "" }]])).map(r => [r.field, r.pack]);
      for (const m of game.messages.contents.filter(m => !before3.has(m.id))) await m.delete().catch(() => {});
      await game.settings.set("cp2020-augmented", "weaponReviewMessageId", "");   // the card above was deleted by hand here

      /* ⭐ THE LONG CARD (user, 2026-09-19: hundreds of rows in a severe world): the rows scroll inside
         the card while heading and buttons stay put; Apply all is ONE write per actor, not one per row */
      const act2 = await Actor.create({ name: "__PW__DR Owner Two", type: "character" });
      const many = [];
      for (let n = 0; n < 30; n++) many.push({ name: `__PW__DR Bulk ${String(n).padStart(2, "0")}`, type: "weapon", system: { weaponType: "Pistol", reliability: "VeryReliable", attackType: "Auto", concealability: "ConcealPocket" } });
      const w1s = await act.createEmbeddedDocuments("Item", many.slice(0, 15));
      const w2s = await act2.createEmbeddedDocuments("Item", many.slice(15));
      const packs2 = new Map(many.map(m => [m.name.toLowerCase().replace(/[^a-z0-9]/g, ""), { reliability: "Standard", attackType: "", concealability: "ConcealJacket" }]));
      const rowsMany = [...w1s.map(w => ({ actorName: act.name, actorUuid: act.uuid, itemName: w.name, uuid: w.uuid, stats: { systemVersion: "1.0.3" }, system: w._source.system })),
                        ...w2s.map(w => ({ actorName: act2.name, actorUuid: act2.uuid, itemName: w.name, uuid: w.uuid, stats: { systemVersion: "1.0.3" }, system: w._source.system }))];
      out.groupsPure = M.groupRowsByActor(M.suspectWeaponRows(rowsMany, packs2)).map(g => [g.actorName, g.count, g.rows.length]);
      const before4 = new Set(game.messages.contents.map(m => m.id));
      const r4 = await M.reviewSuspectWeapons({ force: true, packByKey: packs2, weapons: rowsMany });
      out.manyRows = r4.rows.length;   // 2 fields × 30 (a blank compendium attack type is never a row)
      // the geometry needs a LAID-OUT card: open the chat tab and take the copy in the chat log
      try { ui.sidebar?.changeTab?.("chat", "primary"); } catch (_e) { document.querySelector('#sidebar [data-tab="chat"]')?.click(); }
      await sleep(300);
      let list = null;
      for (let i = 0; i < 40 && !list; i++) { list = [...document.querySelectorAll(".chat-message .cp-data-review .cp-data-review-rows")].find(el => el.clientHeight > 0) ?? null; if (!list) await sleep(100); }
      const cs = list ? getComputedStyle(list) : null;
      out.listGeom = list ? { overflowY: cs.overflowY, maxHeight: cs.maxHeight, scrollH: list.scrollHeight, clientH: list.clientHeight, host: list.closest("#chat-log, #chat-notifications, .chat-log, #chat")?.id ?? list.closest(".chat-log, .chat-sidebar, #sidebar")?.className ?? "?" } : null;
      out.listScrolls = !!list && cs.overflowY === "auto" && list.scrollHeight > list.clientHeight + 20;
      out.listCapped = !!list && list.clientHeight <= Math.ceil(window.innerHeight * 0.4) + 2;
      const card2 = list?.closest(".cp-data-review");
      // ⭐ PER-ACTOR HEADERS (user, 2026-09-19): one per actor, in sweep order, with the count; the name opens the actor
      const heads = [...(card2?.querySelectorAll(".cp-data-review-actor-head") ?? [])];
      out.heads = heads.map(h => [h.firstChild?.textContent?.trim(), h.querySelector(".cp-data-review-actor-count")?.textContent?.trim(), h.dataset.actorUuid]);
      out.rowsUnderFirstHead = (() => { let n = 0, el = heads[0]?.nextElementSibling; while (el && el.classList.contains("cp-data-review-row")) { n++; el = el.nextElementSibling; } return n; })();
      out.noPerRowActorLine = !card2?.querySelector(".cp-data-review-row .cp-data-review-actor");
      heads[1]?.click();
      for (let i = 0; i < 40; i++) { await sleep(100); if (act2.sheet?.rendered) break; }
      out.headOpensActor = act2.sheet?.rendered === true;
      await act2.sheet?.close().catch(() => {});
      out.buttonsOutsideScroller = !!card2 && !list.contains(card2.querySelector(".cp-data-review-apply-all")) && !list.contains(card2.querySelector("h3"));
      // count the writes: one updateEmbeddedDocuments per actor
      const calls = [];
      const origU = Actor.prototype.updateEmbeddedDocuments;
      Actor.prototype.updateEmbeddedDocuments = function (...args) { calls.push([this.name, args[1]?.length]); return origU.apply(this, args); };
      try {
        card2?.querySelector(".cp-data-review-apply-all")?.click();
        out.confirmBulk = await answerConfirm();
        for (let i = 0; i < 100; i++) { await sleep(100); if (w2s.every(w => w._source.system.concealability === "ConcealJacket") && w1s.every(w => w._source.system.reliability === "Standard")) break; }
        await sleep(300);
      } finally { Actor.prototype.updateEmbeddedDocuments = origU; }
      out.batchCalls = calls;
      out.allApplied = [...w1s, ...w2s].every(w => w._source.system.reliability === "Standard" && w._source.system.attackType === "Auto" && w._source.system.concealability === "ConcealJacket");
      out.allMarked = card2 ? card2.querySelectorAll(".cp-data-review-row.cp-data-review-done").length : -1;
      for (const m of game.messages.contents.filter(m => !before4.has(m.id))) await m.delete().catch(() => {});
      await game.settings.set("cp2020-augmented", "weaponReviewMessageId", "");
      await act2.delete();
    } finally { try { await act?.delete(); } catch (_e) {} }
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
check("⭐ NOT ONCE-EVER: an unforced call posts while rows remain and nothing is dismissed", notice.unforcedPosted === true);
check("the standing card's id is kept", notice.cardIdKept === true);
check("a second unforced call REPLACES the standing card — one card, never a stack", notice.secondReplaces === true);
check("the card carries a Don't-show-again button", notice.dismissRendered === true);
check("pressing it stamps the dismissal and takes the card down", notice.dismissed === true && notice.cardGone === true, JSON.stringify([notice.dismissed, notice.cardGone]));
eq("after it an unforced call is skipped", notice.gated, "dismissed");
check("…and a forced call (the console re-post) still posts", notice.forcedAfter === true);
eq("two sweeps in flight together leave exactly ONE card (serialised per client)", notice.concurrentCards, 1);
eq("the rig's own world (all current-build items) has no suspects", notice.realWorld, 0);
eq("…and that sweep read NO compendium index (the pack reads wait for a candidate)", notice.cleanWorldIndexReads, 0);
check("⭐ the settings menu carries a GM-only 'Post the review card' button", notice.menu?.restricted === true && notice.menu?.type === "DataReviewMenu" && notice.menu?.label === "Post the review card", JSON.stringify(notice.menu));
check("…pressing it over a clean world says nothing needs a second look, and posts no card", notice.menuSaidNothing === true && notice.menuCards === 0, JSON.stringify([notice.menuSaidNothing, notice.menuCards]));
eq("⭐ THE GM'S HAND: a card over two real weapons carries their rows (reliability + concealability each)", notice.liveRows, 4);
check("the card renders in the chat log", notice.cardRendered === true);
eq("each Apply button carries the compendium value it would write", notice.buttonCarriesValue, "Standard");
eq("each row names the pack its compendium value comes from", notice.rowNamesSource, "Pistols (test pack)");
check("⭐ Apply ASKS FIRST: the dialog names the weapon, the field, the value and the pack, and a decline writes nothing", notice.declined?.seen === true && /Suspect One/.test(notice.declined.text) && /Reliability/.test(notice.declined.text) && /Standard/.test(notice.declined.text) && /test pack/.test(notice.declined.text) && notice.afterDecline?.rel === "VeryReliable" && notice.afterDecline?.btnEnabled === true, JSON.stringify([notice.declined?.text?.slice(0, 120), notice.afterDecline]));
check("...the dialog offers 'don't ask again for this card'", notice.confirmOne?.seen === true && notice.confirmOne?.hadNoAsk === true, JSON.stringify(notice.confirmOne));
eq("pressing ONE Apply writes that one field on that one weapon", notice.afterOne?.one, ["Standard", "ConcealPocket"]);
eq("…and the other weapon is untouched", notice.afterOne?.two, ["VeryReliable", "ConcealPocket"]);
check("…the pressed button is spent and its row marked done", notice.afterOne?.btnDisabled === true && notice.afterOne?.rowDone === true, JSON.stringify(notice.afterOne));
check("...after 'don't ask again', the next single Apply on this card writes without a dialog", notice.secondAsked === false && notice.afterSecondSingle === "ConcealJacket", JSON.stringify([notice.secondAsked, notice.afterSecondSingle]));
check("⭐ Apply all asks with the count and the actor count, and names the pack", notice.confirmAll?.seen === true && /2 value/.test(notice.confirmAll.text) && /1 actor/.test(notice.confirmAll.text) && /test pack/.test(notice.confirmAll.text), notice.confirmAll?.text?.slice(0, 160));
eq("Apply all presses every row still standing", [notice.afterAll?.one, notice.afterAll?.two], [["Standard", "ConcealJacket"], ["Standard", "ConcealJacket"]]);
eq("NEGATIVE: a non-GM is refused at the action layer", notice.refused?.skipped, "permission");
eq("…and nothing was written", notice.refusedLeft, "Standard");
eq("NEGATIVE: a field the notice never names is refused", notice.badField?.skipped, "field");
eq("the base skill model reads a blank stat as cool (its own migrateData) - the reason skills are not reviewed", notice.blankStatReadsAs, "cool");
eq("NEGATIVE: a skill record makes no row", notice.skillRows, 0);
eq("NEGATIVE: a weapon field is refused on a skill", notice.skillRefusesWeaponField, "field");
eq("NEGATIVE: the stat field is refused on a skill too (no skill field is declared)", notice.skillRefusesStat, "field");
eq("the pack key is type-qualified: the weapon entry answers for the weapon", notice.typedKeyRows, [["reliability", "Standard"]]);
eq("⭐ THE LONG CARD: 30 weapons over two actors make 60 rows (two fields each; a blank compendium attack type is no row)", notice.manyRows, 60);
eq("the pure grouping: two actors, thirty values each, rows kept", notice.groupsPure, [["__PW__DR Owner", 30, 30], ["__PW__DR Owner Two", 30, 30]]);
check("⭐ PER-ACTOR HEADERS: one per actor, in order, with the count and the actor's uuid", Array.isArray(notice.heads) && notice.heads.length === 2 && notice.heads[0][0] === "__PW__DR Owner" && notice.heads[1][0] === "__PW__DR Owner Two" && notice.heads.every(h => h[1] === "30 value(s)" && /^Actor\./.test(h[2])), JSON.stringify(notice.heads));
eq("…the first header is followed by exactly its actor's rows", notice.rowsUnderFirstHead, 30);
check("…and no row repeats the actor's name", notice.noPerRowActorLine === true);
check("…clicking a header opens that actor's sheet", notice.headOpensActor === true);
check("the rows scroll inside the card (overflow auto, content taller than the box)", notice.listScrolls === true, JSON.stringify(notice.listGeom));
check("…capped at ~40% of the viewport", notice.listCapped === true);
check("…with the heading and the buttons outside the scroller", notice.buttonsOutsideScroller === true);
check("the long card's Apply all asks with sixty values over two actors", notice.confirmBulk?.seen === true && /60 value/.test(notice.confirmBulk.text) && /2 actor/.test(notice.confirmBulk.text), notice.confirmBulk?.text?.slice(0, 120));
check("Apply all is ONE write per actor (15 items each), not one per row", Array.isArray(notice.batchCalls) && notice.batchCalls.length === 2 && notice.batchCalls.every(c => c[1] === 15), JSON.stringify(notice.batchCalls));
check("…and every field on every weapon landed", notice.allApplied === true);
eq("…and every row is marked done", notice.allMarked, 60);

/* ─────────────────── §4 the selects ─────────────────── */
console.log("\n§4 the selects no longer lie");
const sel = await page.evaluate(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  let w = null, c = null, pr = null, ar = null;
  try {
    w = await Item.create({ name: "__PW__DR Select", type: "weapon", system: { weaponType: "melee", reliability: "sometimes", cost: 1 } });
    await w.sheet.render(true);
    let root = null; for (let i = 0; i < 40 && !root; i++) { root = w.sheet.element?.querySelector?.('select[name="system.reliability"]') ? w.sheet.element : null; await sleep(100); }
    const rel = root.querySelector('select[name="system.reliability"]'), wt = root.querySelector('select[name="system.weaponType"]');
    out.relShown = rel?.value; out.wtShown = wt?.value;
    out.relFirst = rel?.options?.[0]?.value; out.hasBlank = rel?.options?.[0]?.value === "";
    out.relOddLabel = rel?.selectedOptions?.[0]?.textContent?.trim() ?? "";
    out.relOddIsLast = rel ? rel.options[rel.options.length - 1]?.value === "sometimes" : false;
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
    // the program type dropdown offers a blank, and a submit through another field keeps a blank type
    pr = await Item.create({ name: "__PW__DR Program", type: "program", system: { programType: "", cost: 1 } });
    await pr.sheet.render(true);
    let proot = null; for (let i = 0; i < 40 && !proot; i++) { proot = pr.sheet.element?.querySelector?.('select[name="system.programType"]') ? pr.sheet.element : null; await sleep(100); }
    const psel = proot?.querySelector('select[name="system.programType"]');
    out.programHasBlank = psel?.options?.[0]?.value === "";
    out.programShown = psel?.value;
    const pcost = proot?.querySelector('input[name="system.cost"]');
    if (pcost) { pcost.value = "2"; pcost.dispatchEvent(new Event("change", { bubbles: true })); }
    for (let i = 0; i < 30; i++) { await sleep(100); if (pr._source.system.cost === 2) break; }
    await sleep(300);
    out.programStoredAfter = pr._source.system.programType; out.programCost = pr._source.system.cost;
    await pr.sheet.close();
    // armor: our own pack's "Soft" reads as "soft" and the dropdown shows it; a submit keeps it
    ar = await Item.create({ name: "__PW__DR Armor", type: "armor", system: { armorType: "Soft", cost: 1 } });
    out.armorRead = ar.system.armorType; out.armorSource = ar._source.system.armorType;
    await ar.sheet.render(true);
    let aroot = null; for (let i = 0; i < 40 && !aroot; i++) { aroot = ar.sheet.element?.querySelector?.('select[name="system.armorType"]') ? ar.sheet.element : null; await sleep(100); }
    out.armorShown = aroot?.querySelector('select[name="system.armorType"]')?.value;
    const acost = aroot?.querySelector('input[name="system.cost"]');
    if (acost) { acost.value = "2"; acost.dispatchEvent(new Event("change", { bubbles: true })); }
    for (let i = 0; i < 30; i++) { await sleep(100); if (ar._source.system.cost === 2) break; }
    await sleep(300);
    out.armorStoredAfter = ar._source.system.armorType;
    await ar.sheet.close();
  } catch (e) { out.threw = String(e?.message ?? e) + " " + String(e?.stack ?? "").split("\n")[1]; }
  finally { for (const d of [w, c, pr, ar]) { try { await d?.delete(); } catch (_e) {} } }
  return out;
});
check("the select section ran", !sel.threw, String(sel.threw ?? ""));
eq("⭐ an unrecognised stored reliability is SHOWN as its own entry, not hidden behind a blank (user ruling 2026-09-20)", sel.relShown, "sometimes");
check("...labelled as not a listed choice, appended after the real choices", /not a listed choice/.test(sel.relOddLabel) && sel.relOddIsLast === true, JSON.stringify([sel.relOddLabel, sel.relOddIsLast]));
check("and the blank option is still there for a deliberate clearing", sel.hasBlank === true, String(sel.relFirst));
eq("an unrecognised weapon type is shown the same way", sel.wtShown, "melee");
check("⭐ a submit through another field KEEPS the odd values exactly - nothing rewritten, nothing blanked",
  sel.costStored === 2 && sel.relStoredAfterSubmit === "sometimes" && sel.wtStoredAfterSubmit === "melee",
  JSON.stringify([sel.relStoredAfterSubmit, sel.wtStoredAfterSubmit, sel.costStored]));
check("the program type dropdown offers a blank and a blank program stays blank through a submit", sel.programHasBlank === true && sel.programShown === "" && sel.programStoredAfter === "" && sel.programCost === 2, JSON.stringify([sel.programHasBlank, sel.programShown, sel.programStoredAfter, sel.programCost]));
check("armor: our pack's 'Soft' reads as 'soft', the dropdown shows soft, and a submit keeps soft", sel.armorRead === "soft" && sel.armorShown === "soft" && sel.armorStoredAfter === "soft", JSON.stringify([sel.armorRead, sel.armorSource, sel.armorShown, sel.armorStoredAfter]));
eq("the cyberweapon reliability select shows Standard for a stored 'st' — read as the enum, not blank, not Very Reliable", sel.cyberRelShown, "Standard");
eq("and its unrecognised weapon type 'pistol' is shown as its own entry", sel.cyberWtShown, "pistol");

console.log("\n§5 client health");
eq("0 console errors", errors.slice(0, 4), []);
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
