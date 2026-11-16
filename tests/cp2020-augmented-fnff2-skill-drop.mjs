/**
 * FNFF2 STYLES ON THE SHEET — the thirteen styles printed outside the core book, with the optional rule off.
 *
 * The base seeds every default skill on a new character, those thirteen included, and gates them behind the
 * Friday Night Fistfight 2 world setting: its list filter dropped them from the rendered rows, so a compendium
 * drop of one (a duplicate the guard absorbs) was answered with a "shown below" banner over a row that was never
 * rendered — the sheet was left searched down to nothing (community report, 2026-11). The rule now changes the
 * math, never the list.
 *
 * Proves, by VALUE, on the ship target (:30004, base 1.1.1 + module), through the sheet's real drop entry
 * (`_onDropItem` with the resolved compendium document, as core's `_onDrop` hands it over):
 *   §1  rule OFF + a gated style: the row renders hidden (listed, not filtered), the drop is absorbed, the banner is
 *       the rule-off text (names the skill and the rule's setting label), and the reveal SHOWS the row;
 *   §1b closed enumeration: all thirteen are seeded, listed and rendered with the rule off; the style resolver names
 *       each by its stable id (five carry hyphens or spaces in the pack) and a renamed copy by its compendium source;
 *   §2  NEGATIVE: rule OFF + a core style: the ordinary banner and the ordinary reveal (the old path is intact);
 *   §3  rule ON + the gated style: the ordinary banner (no rule note) and the reveal;
 *   §4  trained stays: a gated style at level 3 is listed with an empty search, and the martial dialog's style list
 *       offers it with the rule off — an untrained one is not; the base's own key-attack table still zeroes it with
 *       the rule off and prints it with the rule on (the documented limit of this unit);
 *   §5  a swing through the sheet's martial row with the gated style selected, rule OFF: a roll card posts naming it.
 * Settings moved: cyberpunk2020.fnff2Enabled, cyberpunk2020.fumbleTableEnabled (restored in finally).
 * Fixture: one __PW__ actor, deleted in finally. Red-first; wording names mechanisms.
 * Run: node tests/cp2020-augmented-fnff2-skill-drop.mjs (default :30004).
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const page = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 240)); });
await joinGM(page);

const r = await page.evaluate(async () => {
  const out = { checks: [], notes: {} };
  const add = (name, ok, detail = "") => out.checks.push({ name, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const GATED = "Martial Arts: PanzerFaust";          // one of the thirteen, printed in Solo of Fortune 2
  const GATED2 = "Martial Arts: Sumo";                // a second of the thirteen, left untrained
  const LISTED = "Martial Arts: Aikido";              // a core style
  const KARATE = "Martial Arts: Karate";
  const SETTING = "fnff2Enabled";
  const L = await import("/modules/cp2020-augmented/module/lookups.js");
  const M = await import("/modules/cp2020-augmented/module/martial/martial.js");
  const BL = await import("/systems/cyberpunk2020/module/lookups.js");
  let fnff2Was = null, fumbleWas = null, actor = null;
  const warns = [];
  const origWarn = ui.notifications.warn.bind(ui.notifications);
  ui.notifications.warn = (msg, ...rest) => { warns.push(String(msg)); return origWarn(msg, ...rest); };
  const dropEvent = () => ({ preventDefault() {}, target: document.body });
  const rootOf = (sheet) => sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
  const rowOf = (sheet, id) => rootOf(sheet)?.querySelector(`.field.skill[data-item-id="${id}"]`) ?? null;
  const hiddenRow = (sheet, id) => { const r = rowOf(sheet, id); return !!r && r.classList.contains("cp-hidden"); };
  const visibleRow = (sheet, id) => { const r = rowOf(sheet, id); return !!r && !r.classList.contains("cp-hidden"); };
  const searchOf = (sheet) => rootOf(sheet)?.querySelector("input.skill-search")?.value ?? null;
  const skillsNamed = (name) => actor.items.filter(i => i.type === "skill" && i.name === name).length;
  const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(100); } return null; };
  const clearSearch = async (sheet) => { sheet._cpSkillFilter = ""; await sheet.render(true); await sleep(1100); };
  try {
    fnff2Was = game.settings.get("cyberpunk2020", SETTING);
    fumbleWas = game.settings.get("cyberpunk2020", "fumbleTableEnabled");
    out.notes.fnff2Was = fnff2Was;
    out.notes.moduleVersion = game.modules.get("cp2020-augmented")?.version;
    const settingLabel = game.i18n.localize("SETTINGS.FNFF2Enabled");
    out.notes.settingLabel = settingLabel;
    const ordinary = (name) => game.i18n.format("CYBERPUNK.SkillAlreadyOnSheet", { name });
    const ruleOff = (name) => game.i18n.format("CYBERPUNK.SkillAlreadyOnSheetFnff2Off", { name, setting: settingLabel });

    // the drag source: the base's default-skills compendium
    const pack = game.packs.get("cyberpunk2020.default-skills-en");
    const idx = await pack.getIndex();
    const docOf = async (name) => pack.getDocument(idx.find(x => x.name === name)?._id);
    const gatedDoc = await docOf(GATED); const listedDoc = await docOf(LISTED);
    add("fixture: the base skill compendium carries both styles (the drag source)", !!gatedDoc && !!listedDoc, { gated: gatedDoc?.id, listed: listedDoc?.id });

    // ── §1 rule OFF (the world default) + a gated style ──
    await game.settings.set("cyberpunk2020", SETTING, false);
    actor = await Actor.create({ name: "__PW__ Gated Style", type: "character" });
    const byKey = (key) => actor.items.get(L.MARTIAL_ART_ID_BY_KEY[key]) ?? null;   // a seeded style keeps its compendium id
    const gated = byKey(GATED), gated2 = byKey(GATED2), listed = byKey(LISTED), karate = byKey(KARATE);
    add("fixture: the base seeded the styles on the fresh character at level 0", !!gated && !!gated2 && !!listed && !!karate && [gated, gated2, listed, karate].every(s => !(Number(s.system?.level) || 0)), { gated: gated?.id, listed: listed?.id });
    const sheet = actor.sheet;
    await sheet.render(true); await sleep(1100);
    add("§1 i18n: the rule-off banner key exists", game.i18n.has("CYBERPUNK.SkillAlreadyOnSheetFnff2Off"));
    add("§1 rule OFF: the gated style RENDERS, hidden while untrained with an empty search (listed like any style, not filtered out)", hiddenRow(sheet, gated?.id), { rendered: !!rowOf(sheet, gated?.id) });
    warns.length = 0;
    const before1 = skillsNamed(GATED);
    await sheet._onDropItem(dropEvent(), gatedDoc); await sleep(900);
    add("§1 rule OFF: the drop is absorbed — no second row of the gated style", skillsNamed(GATED) === before1 && before1 === 1, { before: before1, after: skillsNamed(GATED) });
    add("§1 rule OFF: exactly one banner, the rule-off text (names the skill and the rule's setting label, states the limit)", warns.length === 1 && warns[0] === ruleOff(GATED), { warns, expected: ruleOff(GATED) });
    add("§1 rule OFF: the reveal SHOWS the row (the search carries the name, the row is visible)", searchOf(sheet) === GATED && visibleRow(sheet, gated?.id), { search: searchOf(sheet), visible: visibleRow(sheet, gated?.id) });
    await clearSearch(sheet);

    // ── §1b closed enumeration of the thirteen, rule OFF ──
    const keys = [...L.FNFF2_ONLY_MARTIAL_ART_KEYS];
    const seeded = keys.map(k => ({ key: k, item: byKey(k) }));
    add("§1b the gated set is thirteen styles, every one a seeded skill item found by its stable id", keys.length === 13 && seeded.every(s => !!s.item), seeded.filter(s => !s.item).map(s => s.key));
    const list = sheet._getSortedSkillIDs({ system: actor.system });
    add("§1b rule OFF: the sorted-skill list carries all thirteen", seeded.every(s => s.item && list.includes(s.item.id)), seeded.filter(s => s.item && !list.includes(s.item.id)).map(s => s.key));
    add("§1b rule OFF: all thirteen render as rows, each hidden while untrained", seeded.every(s => s.item && hiddenRow(sheet, s.item.id)), seeded.filter(s => !(s.item && hiddenRow(sheet, s.item.id))).map(s => s.key));
    add("§1b the style resolver names each of the thirteen by its stable id, and null for a core style (Aikido · Karate)",
      seeded.every(s => M.fnff2OnlyStyleKeyOf?.(s.item) === s.key) && M.fnff2OnlyStyleKeyOf?.(listed) === null && M.fnff2OnlyStyleKeyOf?.(karate) === null,
      seeded.map(s => [s.key, M.fnff2OnlyStyleKeyOf?.(s.item) ?? "(no resolver)"]).filter(([k, v]) => k !== v));
    const copyData = game.items.fromCompendium(gatedDoc); copyData.name = "__PW__ renamed copy";
    add("§1b a renamed compendium copy still resolves through its compendium source (never by name)", M.fnff2OnlyStyleKeyOf?.(copyData) === GATED, { src: copyData._stats?.compendiumSource ?? null, got: M.fnff2OnlyStyleKeyOf?.(copyData) ?? null });

    // ── §2 NEGATIVE: rule OFF + a core style → the ordinary path ──
    warns.length = 0;
    add("§2 fixture: the core style renders, hidden while untrained with an empty search", hiddenRow(sheet, listed?.id));
    const before2 = skillsNamed(LISTED);
    await sheet._onDropItem(dropEvent(), listedDoc); await sleep(900);
    add("§2 NEGATIVE rule OFF, core style: absorbed, the ORDINARY banner, and the reveal shows the row",
      skillsNamed(LISTED) === before2 && warns.length === 1 && warns[0] === ordinary(LISTED) && searchOf(sheet) === LISTED && visibleRow(sheet, listed?.id),
      { warns, search: searchOf(sheet), visible: visibleRow(sheet, listed?.id) });
    await clearSearch(sheet);

    // ── §3 rule ON + the gated style → the ordinary path ──
    await game.settings.set("cyberpunk2020", SETTING, true);
    await sheet.render(true); await sleep(1100);
    add("§3 rule ON: the gated style renders, hidden while untrained with an empty search", hiddenRow(sheet, gated?.id));
    warns.length = 0;
    const before3 = skillsNamed(GATED);
    await sheet._onDropItem(dropEvent(), gatedDoc); await sleep(900);
    add("§3 rule ON, gated style: absorbed, the ORDINARY banner (no rule note), and the reveal shows the row",
      skillsNamed(GATED) === before3 && warns.length === 1 && warns[0] === ordinary(GATED) && searchOf(sheet) === GATED && visibleRow(sheet, gated?.id),
      { warns, search: searchOf(sheet), visible: visibleRow(sheet, gated?.id) });
    await clearSearch(sheet);

    // ── §4 trained stays, and the martial dialog's style list, rule OFF ──
    await game.settings.set("cyberpunk2020", SETTING, false);
    await gated.update({ "system.level": 3 }); await karate.update({ "system.level": 2 });
    await clearSearch(sheet);
    add("§4 rule OFF: a trained gated style is listed with an empty search (trained stays), the untrained one stays hidden", visibleRow(sheet, gated?.id) && hiddenRow(sheet, gated2?.id) && searchOf(sheet) === "", { gated: visibleRow(sheet, gated?.id), gated2hidden: hiddenRow(sheet, gated2?.id) });
    const offered = M.trainedMartials(actor).map(m => m.value);
    add("§4 rule OFF: the dialog's style list offers the trained gated style beside the trained core style", offered.includes(GATED) && offered.includes(KARATE), offered);
    add("§4 NEGATIVE rule OFF: an untrained gated style is not offered", !offered.includes(GATED2), offered);
    const bonusOff = BL.getMartialActionBonus(GATED, "Kick");
    await game.settings.set("cyberpunk2020", SETTING, true);
    const bonusOn = BL.getMartialActionBonus(GATED, "Kick");
    await game.settings.set("cyberpunk2020", SETTING, false);
    add("§4 the base's own key-attack table zeroes the gated style with the rule off and prints Kick +3 with it on (the limit the banner states)", bonusOff === 0 && bonusOn === 3, { off: bonusOff, on: bonusOn });

    // ── §5 a swing through the sheet's martial row with the gated style, rule OFF ──
    await game.settings.set("cyberpunk2020", "fumbleTableEnabled", false);
    const stampedId = actor.itemTypes.weapon.find(w => w.system?.attackType === "Martial")?.id ?? "";
    const before = new Set(game.messages.map(m => m.id));
    sheet._cpOpenMartialActionDialog({ dataset: { action: "Kick", itemId: stampedId } });
    const dlg = await waitFor(() => [...foundry.applications.instances.values()].find(a => a.element?.querySelector?.(".weapon-modifiers")), 5000);
    await sleep(300);
    const root = dlg?.element;
    const sel = root?.querySelector('select[name="fields.martialArt"], select[name="martialArt"]');
    const options = sel ? [...sel.options].map(o => o.value) : [];
    add("§5 rule OFF: the dialog's style select lists the trained gated style", !!dlg && options.includes(GATED), { opened: !!dlg, options });
    if (sel) { sel.value = GATED; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    const artSet = sel?.value === GATED;
    root?.querySelector('button.fire, button[type="submit"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    let card = null;
    for (let i = 0; i < 60 && !card; i++) { await sleep(100); card = [...game.messages].reverse().find(m => !before.has(m.id) && (m.rolls?.length ?? 0) > 0) ?? null; }
    await sleep(400);
    try { await dlg?.close?.(); } catch (_e) { /* closed */ }
    const text = ((card?.flavor ?? "") + " " + (card?.content ?? "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    add("§5 rule OFF: the swing posts a roll card naming the style (the base rolls it at its printed difficulty)", artSet && !!card && /PanzerFaust/i.test(text), { artSet, cardId: card?.id ?? null, text: text.slice(0, 140) });
    out.notes.swingFormula = card?.rolls?.[0]?.formula ?? null;
    await sheet.close();
  } catch (e) {
    add("§x run completed without a thrown error", false, e?.stack ?? String(e));
  } finally {
    ui.notifications.warn = origWarn;
    try { if (fnff2Was !== null) await game.settings.set("cyberpunk2020", SETTING, fnff2Was); } catch (_e) { /* ignore */ }
    try { if (fumbleWas !== null) await game.settings.set("cyberpunk2020", "fumbleTableEnabled", fumbleWas); } catch (_e) { /* ignore */ }
    try { await actor?.delete(); } catch (_e) { /* ignore */ }
    out.notes.fnff2Restored = game.settings.get("cyberpunk2020", SETTING);
    out.notes.strays = game.actors.filter(a => a.name.startsWith("__PW__")).length;
  }
  return out;
});
await b.close();

let fail = 0;
for (const c of r.checks) { if (!c.ok) fail++; console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "  got=" + c.detail}`); }
const errLeg = errors.length === 0;
console.log(`${errLeg ? "PASS" : "FAIL"}  0 console errors${errLeg ? "" : "  got=" + JSON.stringify(errors.slice(0, 5))}`);
if (!errLeg) fail++;
console.log("notes:", JSON.stringify(r.notes));
console.log(`RESULT: ${fail ? "FAIL" : "ALL GREEN"}  ${r.checks.length + 1 - fail}/${r.checks.length + 1}`);
process.exit(fail ? 1 : 0);
