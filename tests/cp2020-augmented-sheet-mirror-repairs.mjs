/** Sheet-layer MIRROR repairs against the base system's released 1.1.1 behaviour.
 *
 *  Our replacing sheets dropped six behaviours the base system's own sheets ship. Each check below
 *  drives the REAL DOM gesture on the REAL sheet and asserts the resulting VALUES:
 *
 *   M1  skill rows render the resolved display name, and the skill search matches it
 *   M2  the chip item sheet's ChipActive checkbox syncs chipLevel/isChipped onto the skill items
 *   M3  a ChipSkills level input mirrors the entered level onto the skill while the chip is active
 *   M4  unticking the chip's Equipped box forces ChipActive off and resyncs the skills
 *   N1  changing cyberwareType derives CyberBodyType.Type and clears the side field
 *   N2  the combat tab gates cyberweapon fire rows on cwIsEnabled
 *   N3  a sibling cyberware update re-renders an open implant sheet (live "slots left")
 *
 *  The chip lanes (M2/M3/M4) run TWICE — once with the module's document automation ON (the
 *  chip-grant engine creates/deletes granted skill items) and once OFF — because the field sync
 *  repaired here has to compose with that engine without duplicating or fighting it.
 *
 *  The skill-row trio (2026-08-15) rides on the same fixtures, since all three touch the row:
 *
 *   S1  an external skill drop whose name is already on the sheet reveals that row instead of
 *       embedding a twin (two same-named rows make the name-keyed martial reads pick arbitrarily)
 *   S2  the search haystack's name↔display-name field separator holds — neither a space nor the
 *       separator character itself lets a query bridge the two fields
 *   S3  the per-row chip checkbox carries a localized title naming what chipping does to the roll
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
  const out = { chipLanes: {} };
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const AIKIDO_ID = "oeXfrhKtdtuxn5dx";           // MARTIAL_ART_ID_BY_KEY["Martial Arts: Aikido"]
  const SCOPE = "cp2020-augmented";

  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const rootOf = (app) => (app?.element instanceof HTMLElement ? app.element : app?.element?.[0] ?? null);
  const openSheet = async (doc, ms = 700) => { await doc.sheet.render(true); await sleep(ms); return rootOf(doc.sheet); };

  // ── fixtures ───────────────────────────────────────────────────────────────
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__MIRROR"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__MIRROR Punk", type: "character" });
  await actor.update({ "system.stats.int.base": 9, "system.stats.ref.base": 6 });
  await sleep(200);

  // ── M1 · display name + search ─────────────────────────────────────────────
  // A martial-art skill whose RAW name deliberately differs from its resolved display name, so the
  // two assertions below can only pass through the display-name resolution (not the raw name).
  // A fresh character is seeded with the default skill set, so the martial-art item usually exists
  // already — rename it rather than creating a duplicate id.
  if (actor.items.get(AIKIDO_ID)) {
    await actor.updateEmbeddedDocuments("Item", [{ _id: AIKIDO_ID, name: "__PW__RawMartial", "system.level": 2, "system.chipLevel": 0, "system.isChipped": false }]);
  } else {
    await actor.createEmbeddedDocuments("Item", [{
      _id: AIKIDO_ID, name: "__PW__RawMartial", type: "skill",
      system: { level: 2, chipLevel: 0, isChipped: false, ip: 0, diffMod: 1, stat: "ref", isRoleSkill: false }
    }], { keepId: true });
  }
  await sleep(200);
  const martial = actor.items.get(AIKIDO_ID);

  const expectedDisplay = actor.getSkillDisplayName?.(martial) ?? null;
  const aRoot = await openSheet(actor, 900);
  const rowSel = `.field.skill[data-item-id="${AIKIDO_ID}"]`;
  const labelEl = aRoot?.querySelector(`${rowSel} label.skill-roll`);
  out.m1 = {
    helperExists: typeof actor.getSkillDisplayName === "function",
    expectedDisplay,
    rendered: labelEl ? labelEl.textContent.trim() : null,
    rawName: martial.name
  };

  // search gesture: the query matches only the DISPLAY name, never the raw name
  const searchEl = aRoot?.querySelector("input.skill-search");
  const rowHidden = () => !!aRoot?.querySelector(rowSel)?.classList.contains("cp-hidden");
  if (searchEl) { searchEl.value = "Aikido"; fire(searchEl, "input"); }
  await sleep(250);
  out.m1.hiddenForDisplayNameQuery = rowHidden();
  if (searchEl) { searchEl.value = "__PW__RawMartial"; fire(searchEl, "input"); }
  await sleep(250);
  out.m1.hiddenForRawNameQuery = rowHidden();
  if (searchEl) { searchEl.value = "ZZZ_NO_SUCH_SKILL"; fire(searchEl, "input"); }
  await sleep(250);
  out.m1.hiddenForMissQuery = rowHidden();
  if (searchEl) { searchEl.value = ""; fire(searchEl, "input"); }
  await sleep(150);
  await actor.sheet.close();
  await sleep(200);

  // ── M2 / M3 / M4 · chip sheet lanes, run under BOTH automation states ───────
  //
  //  ⚠ The expected values below are MEASURED from the base system's own item sheet (a throwaway
  //  probe instantiated its sheet class on identical fixtures on this same rig), not assumed. The
  //  measurement matters because the base actor's prepareData already overrides a skill's PREPARED
  //  chipLevel/isChipped while a chip is active — so the sync's job is not "write the chip level in"
  //  but "reconcile the PERSISTED skill fields when the chip stops driving them". Scenarios seed a
  //  STALE persisted skill (chipLevel 9 / isChipped true) precisely because that is where the
  //  missing handlers were observable: without the sync the skill keeps a chip level after the chip
  //  is switched off or unequipped.
  const chipScenario = async (tag, skillSys, chipSys, gesture) => {
    const [skill] = await actor.createEmbeddedDocuments("Item", [{
      name: `__PW__ChipSkill ${tag}`, type: "skill",
      system: { level: 2, ip: 0, diffMod: 1, stat: "int", isRoleSkill: false, ...skillSys }
    }]);
    const [chip] = await actor.createEmbeddedDocuments("Item", [{
      name: `__PW__Chip ${tag}`, type: "cyberware",
      system: { equipped: true, EffectMode: "Permanent",
        CyberWorkType: { Types: ["Chip"], Stat: {}, Skill: {}, Locations: {}, Penalties: {},
          ChipSkills: { [skill.id]: 5 }, ...chipSys } }
    }]);
    await sleep(300);

    const read = () => {
      const s = actor.items.get(skill.id);
      const c = actor.items.get(chip.id);
      return {
        srcChipLevel: Number(s?._source?.system?.chipLevel ?? -1),
        srcIsChipped: !!s?._source?.system?.isChipped,
        realSkillValue: s ? actor.constructor.realSkillValue(s) : null,
        chipActive: !!c?._source?.system?.CyberWorkType?.ChipActive,
        equipped: c?._source?.system?.equipped !== false,
        mapValue: Number(c?._source?.system?.CyberWorkType?.ChipSkills?.[skill.id] ?? -1)
      };
    };

    const cRoot = await openSheet(chip, 900);
    const before = read();
    const controlFound = await gesture(() => rootOf(chip.sheet), skill.id);
    await sleep(1800);
    const after = read();
    const skillItemCount = actor.items.filter(i => i.type === "skill" && i.name === `__PW__ChipSkill ${tag}`).length;

    await chip.sheet.close().catch(() => {});
    await sleep(200);
    await actor.deleteEmbeddedDocuments("Item", [chip.id, skill.id].filter(id => actor.items.get(id))).catch(() => {});
    await sleep(300);
    return { sheetRendered: !!cRoot, controlFound, before, after, skillItemCount };
  };

  const tickActive = (checked) => async (root) => {
    const el = root()?.querySelector('input[name="system.CyberWorkType.ChipActive"]');
    if (el) { el.checked = checked; fire(el, "change"); }
    return !!el;
  };
  const tickEquipped = (checked) => async (root) => {
    const el = root()?.querySelector('input[name="system.equipped"]');
    if (el) { el.checked = checked; fire(el, "change"); }
    return !!el;
  };
  const typeChipLevel = (value) => async (root, sid) => {
    const el = root()?.querySelector(`input[name="system.CyberWorkType.ChipSkills.${sid}"]`);
    if (el) { el.value = String(value); fire(el, "change"); }
    return !!el;
  };

  const runChipLane = async (automationOn) => {
    await game.settings.set(SCOPE, "mechDocumentAutomation", automationOn);
    await sleep(200);
    const t = automationOn ? "ON" : "OFF";
    const lane = { automationOn };
    // M2 · deactivating clears the stale persisted chip fields
    lane.deactivate = await chipScenario(`${t}-S1`, { chipLevel: 9, isChipped: true }, { ChipActive: true }, tickActive(false));
    // M4 · unequipping forces ChipActive off AND resyncs
    lane.unequip = await chipScenario(`${t}-S2`, { chipLevel: 9, isChipped: true }, { ChipActive: true }, tickEquipped(false));
    // M3 · zeroing the chip's level for a skill mirrors onto the skill's persisted chipLevel
    lane.levelEdit = await chipScenario(`${t}-S3`, { chipLevel: 9, isChipped: true }, { ChipActive: true }, typeChipLevel(0));
    // M2 (positive direction) · activating a clean chip drives the skill value through the base override
    lane.activate = await chipScenario(`${t}-S4`, { chipLevel: 0, isChipped: false }, { ChipActive: false }, tickActive(true));
    return lane;
  };

  const automationWas = game.settings.get(SCOPE, "mechDocumentAutomation");
  out.chipLanes.on = await runChipLane(true);
  out.chipLanes.off = await runChipLane(false);
  await game.settings.set(SCOPE, "mechDocumentAutomation", automationWas);
  await sleep(200);

  // ── N1 · cyberwareType select derives CyberBodyType.Type + clears the side ──
  const [implant] = await actor.createEmbeddedDocuments("Item", [{
    name: "__PW__Implant", type: "cyberware",
    system: {
      equipped: true, EffectMode: "Permanent", cyberwareType: "CyberArm",
      CyberBodyType: { Type: "", Location: "Left" },
      CyberWorkType: { Types: ["Implant"], OptionsAvailable: 4, Stat: {}, Skill: {}, Locations: {}, Penalties: {}, ChipSkills: {} }
    }
  }]);
  await sleep(300);
  let iRoot = await openSheet(implant, 800);
  const typeSel = iRoot?.querySelector('select[name="system.cyberwareType"]');
  out.n1 = { selectPresent: !!typeSel };
  if (typeSel) { typeSel.value = "CyberArm"; fire(typeSel, "change"); }
  await sleep(1000);
  out.n1.afterArm = {
    cyberwareType: actor.items.get(implant.id)?._source?.system?.cyberwareType ?? null,
    bodyType: actor.items.get(implant.id)?._source?.system?.CyberBodyType?.Type ?? null,
    location: actor.items.get(implant.id)?._source?.system?.CyberBodyType?.Location ?? null
  };
  iRoot = rootOf(implant.sheet);
  const typeSel2 = iRoot?.querySelector('select[name="system.cyberwareType"]');
  if (typeSel2) { typeSel2.value = "CyberOptic"; fire(typeSel2, "change"); }
  await sleep(1000);
  out.n1.afterOptic = {
    cyberwareType: actor.items.get(implant.id)?._source?.system?.cyberwareType ?? null,
    bodyType: actor.items.get(implant.id)?._source?.system?.CyberBodyType?.Type ?? null,
    location: actor.items.get(implant.id)?._source?.system?.CyberBodyType?.Location ?? null
  };

  // ── N3 · a sibling update re-renders the open implant sheet (live slots left) ──
  // His refresh hook is `updateItem` only, so the module is mounted BEFORE the implant sheet opens;
  // the assertion is that a later SlotsTaken change moves the readout with the sheet still open.
  await implant.update({ "system.cyberwareType": "CyberArm", "system.CyberBodyType.Type": "Arm", "system.CyberBodyType.Location": "Left" });
  await sleep(400);
  const slotsValue = () => {
    const root = rootOf(implant.sheet);
    const labels = [...(root?.querySelectorAll(".field") ?? [])];
    for (const f of labels) {
      const inp = f.querySelector("input[readonly].smallnumber");
      if (inp && !inp.name) return Number(inp.value);
    }
    return null;
  };
  const [mod] = await actor.createEmbeddedDocuments("Item", [{
    name: "__PW__Module", type: "cyberware",
    system: {
      equipped: true, EffectMode: "Permanent", cyberwareType: "CyberArm",
      CyberBodyType: { Type: "Arm", Location: "Left" },
      Module: { IsModule: true, ParentId: implant.id, SlotsTaken: 1, AllowedParentCyberwareType: "CyberArm" },
      CyberWorkType: { Types: ["Descriptive"], Stat: {}, Skill: {}, Locations: {}, Penalties: {}, ChipSkills: {} }
    }
  }]);
  await sleep(600);
  iRoot = await openSheet(implant, 900);
  const slotsBefore = slotsValue();
  await mod.update({ "system.Module.SlotsTaken": 3 });
  await sleep(1400);
  const slotsAfterBump = slotsValue();
  out.n3 = { slotsBefore, slotsAfterBump };
  await implant.sheet.close().catch(() => {});
  await sleep(200);

  // ── N2 · combat tab gates cyberweapon rows on cwIsEnabled ──────────────────
  const [cwOn] = await actor.createEmbeddedDocuments("Item", [{
    name: "__PW__CwEnabled", type: "cyberware",
    system: { equipped: true, EffectMode: "Permanent",
      CyberWorkType: { Types: ["Weapon"], Weapon: { weaponType: "Pistol", attackType: "Handgun" }, Stat: {}, Skill: {}, Locations: {}, Penalties: {}, ChipSkills: {} } }
  }]);
  const [cwOff] = await actor.createEmbeddedDocuments("Item", [{
    name: "__PW__CwDisabled", type: "cyberware",
    system: { equipped: true, EffectMode: "Activatable", EffectActive: false,
      CyberWorkType: { Types: ["Weapon"], Weapon: { weaponType: "Pistol", attackType: "Handgun" }, Stat: {}, Skill: {}, Locations: {}, Penalties: {}, ChipSkills: {} } }
  }]);
  await sleep(400);
  const aRoot2 = await openSheet(actor, 1000);
  const fireRow = (id) => !!aRoot2?.querySelector(`.weapons-list .fire-weapon[data-item-id="${id}"]`);
  out.n2 = { enabledRow: fireRow(cwOn.id), disabledRow: fireRow(cwOff.id) };
  // flipping the disabled one ON must make its row appear (the gate is live, not a name filter)
  await cwOff.update({ "system.EffectActive": true });
  await sleep(1000);
  const aRoot3 = rootOf(actor.sheet);
  out.n2.disabledRowAfterEnable = !!aRoot3?.querySelector(`.weapons-list .fire-weapon[data-item-id="${cwOff.id}"]`);
  await actor.sheet.close().catch(() => {});
  await sleep(200);

  // ── S1 / S2 / S3 · skill-row trio ──────────────────────────────────────────
  //
  //  S1  DROP DEDUP GUARD — an external skill drop whose name is already on the sheet must reveal
  //      the existing row instead of embedding a twin. Two same-named skill rows make the sheet's
  //      name-keyed martial reads pick arbitrarily, which is the reported live-play failure.
  //  S2  SEARCH FIELD SEPARATOR — the filter haystack joins the raw name and the resolved display
  //      name with a text field separator; a query must not be able to bridge the two fields.
  //  S3  CHIP-TOGGLE TOOLTIP — the per-row chip checkbox carries a localized title naming what the
  //      chipped state does to the roll; a chip-driven row keeps its existing "controlled" title.
  const sheet = actor.sheet;
  const worldItems = [];
  const warned = [];
  const warnWas = ui.notifications.warn.bind(ui.notifications);
  ui.notifications.warn = (msg, ...rest) => { warned.push(String(msg)); return warnWas(msg, ...rest); };

  try {
    const mkWorld = async (name, type, system = {}) => {
      const it = await Item.create({ name, type, system });
      worldItems.push(it);
      return it;
    };
    // Core ActorSheetV2._onDrop resolves the payload to an Item DOCUMENT before calling
    // _onDropItem(event, item) — so the keeper hands it a document, exactly as production does.
    const dropEvent = () => ({ preventDefault() {}, target: document.body });
    const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    const countNamed = (name, type = "skill") =>
      actor.items.filter(i => i.type === type && norm(i.name) === norm(name)).length;
    const rowsOf = (root) => [...(root?.querySelectorAll(".field.skill[data-item-id]") ?? [])];
    const rowOf = (id) => rootOf(sheet)?.querySelector(`.field.skill[data-item-id="${id}"]`) ?? null;
    const rowHiddenOf = (id) => !!rowOf(id)?.classList.contains("cp-hidden");
    const SKILL_SYS = { level: 3, chipLevel: 0, isChipped: false, ip: 0, diffMod: 1, stat: "ref", isRoleSkill: false };

    const sRoot = await openSheet(actor, 1100);
    const rowItems = rowsOf(sRoot).map(el => actor.items.get(el.dataset.itemId)).filter(Boolean);
    // The row that is HIDDEN until the search reveals it — the exact case the user hit: the player
    // can't see the discipline, so they drag a compendium copy in.
    const hiddenSkill = rowItems.find(s => sheet._cpIsUntrainedMartial?.(s) === true) ?? null;
    // A plain, always-visible skill row, used for the case/whitespace normalization leg.
    const plainSkill = rowItems.find(s => s && !s.name.startsWith("__PW__") && sheet._cpIsUntrainedMartial?.(s) !== true) ?? null;

    out.s1 = {
      hintKeyExists: game.i18n.has("CYBERPUNK.SkillAlreadyOnSheet"),
      hiddenSkillFound: !!hiddenSkill,
      plainSkillFound: !!plainSkill,
      hiddenSkillName: hiddenSkill?.name ?? null,
      plainSkillName: plainSkill?.name ?? null
    };

    // S1a · same-name drop onto a row that is currently hidden
    if (hiddenSkill) {
      out.s1.expectedNotice = game.i18n.format("CYBERPUNK.SkillAlreadyOnSheet", { name: hiddenSkill.name });
      out.s1.hiddenBefore = rowHiddenOf(hiddenSkill.id);
      out.s1.countBefore = countNamed(hiddenSkill.name);
      const twin = await mkWorld(hiddenSkill.name, "skill", { ...SKILL_SYS });
      warned.length = 0;
      await sheet._onDropItem(dropEvent(), twin);
      await sleep(1100);
      out.s1.countAfter = countNamed(hiddenSkill.name);
      out.s1.notices = warned.slice();
      out.s1.searchValueAfter = rootOf(sheet)?.querySelector("input.skill-search")?.value ?? null;
      out.s1.rowPresentAfter = !!rowOf(hiddenSkill.id);
      out.s1.hiddenAfter = rowHiddenOf(hiddenSkill.id);
      // clear the reveal so the later legs start from an unfiltered sheet
      const clearEl = rootOf(sheet)?.querySelector("input.skill-search");
      if (clearEl) { clearEl.value = ""; fire(clearEl, "input"); }
      await sleep(250);
    }

    // S1b · the dedup KEY: trimmed, case-folded, whitespace-collapsed
    if (plainSkill) {
      out.s1.varCountBefore = countNamed(plainSkill.name);
      const varied = await mkWorld(`  ${plainSkill.name.toUpperCase()}  `, "skill", { ...SKILL_SYS });
      warned.length = 0;
      await sheet._onDropItem(dropEvent(), varied);
      await sleep(1100);
      out.s1.varCountAfter = countNamed(plainSkill.name);
      out.s1.varNotices = warned.slice();
      const clearEl = rootOf(sheet)?.querySelector("input.skill-search");
      if (clearEl) { clearEl.value = ""; fire(clearEl, "input"); }
      await sleep(250);
    }

    // S1c · NEGATIVE — a genuinely new skill name still embeds
    const novel = await mkWorld("__PW__NovelSkill", "skill", { ...SKILL_SYS });
    out.s1.novelBefore = countNamed("__PW__NovelSkill");
    warned.length = 0;
    await sheet._onDropItem(dropEvent(), novel);
    await sleep(1100);
    out.s1.novelAfter = countNamed("__PW__NovelSkill");
    out.s1.novelNotices = warned.slice();

    // S1d · NEGATIVE — a non-skill drop is untouched by the guard
    const gear = await mkWorld("__PW__NovelGear", "weapon", {});
    out.s1.gearBefore = countNamed("__PW__NovelGear", "weapon");
    await sheet._onDropItem(dropEvent(), gear);
    await sleep(1100);
    out.s1.gearAfter = countNamed("__PW__NovelGear", "weapon");

    // ── S2 · search field separator ────────────────────────────────────────────
    await sheet.render(true);
    await sleep(900);
    const searchEl2 = rootOf(sheet)?.querySelector("input.skill-search");
    const setQuery = async (q) => { if (searchEl2) { searchEl2.value = q; fire(searchEl2, "input"); } await sleep(280); };
    const RAW = "__PW__RawMartial";
    out.s2 = { searchPresent: !!searchEl2, expectedDisplay, rowPresent: !!rowOf(AIKIDO_ID) };
    await setQuery(RAW);
    out.s2.hiddenForRaw = rowHiddenOf(AIKIDO_ID);
    await setQuery(expectedDisplay ?? "");
    out.s2.hiddenForDisplay = rowHiddenOf(AIKIDO_ID);
    // a SPACE cannot bridge the two fields (it did before the fields were separated)
    await setQuery(`${RAW} ${expectedDisplay ?? ""}`);
    out.s2.hiddenForSpaceBridge = rowHiddenOf(AIKIDO_ID);
    // nor can the raw separator character itself, pasted into the query
    await setQuery(`${RAW}\u001F${expectedDisplay ?? ""}`);
    out.s2.hiddenForSeparatorBridge = rowHiddenOf(AIKIDO_ID);
    // and the "hide; search reveals" path still works for a hidden discipline
    if (hiddenSkill) {
      const shortQuery = String(hiddenSkill.name).split(":").pop().trim();
      out.s2.shortQuery = shortQuery;
      await setQuery("");
      out.s2.hiddenSkillHiddenWithNoQuery = rowHiddenOf(hiddenSkill.id);
      await setQuery(shortQuery);
      out.s2.hiddenSkillRevealedByQuery = !rowHiddenOf(hiddenSkill.id);
    }
    await setQuery("");

    // ── S3 · chip-toggle tooltip ───────────────────────────────────────────────
    const [tipSkill] = await actor.createEmbeddedDocuments("Item", [{
      name: "__PW__TipSkill", type: "skill",
      system: { level: 1, chipLevel: 0, isChipped: false, ip: 0, diffMod: 1, stat: "int", isRoleSkill: false }
    }]);
    const [tipChipSkill] = await actor.createEmbeddedDocuments("Item", [{
      name: "__PW__TipChipSkill", type: "skill",
      system: { level: 1, chipLevel: 0, isChipped: false, ip: 0, diffMod: 1, stat: "int", isRoleSkill: false }
    }]);
    await actor.createEmbeddedDocuments("Item", [{
      name: "__PW__TipChip", type: "cyberware",
      system: { equipped: true, EffectMode: "Permanent",
        CyberWorkType: { Types: ["Chip"], ChipActive: true, Stat: {}, Skill: {}, Locations: {}, Penalties: {},
          ChipSkills: { [tipChipSkill.id]: 6 } } }
    }]);
    await sleep(500);
    await sheet.render(true);
    await sleep(1000);
    const boxOf = (id) => rootOf(sheet)?.querySelector(`.field.skill[data-item-id="${id}"] input.chip-toggle-checkbox`) ?? null;
    out.s3 = {
      hintKeyExists: game.i18n.has("CYBERPUNK.SkillChipToggleHint"),
      expectedHint: game.i18n.localize("CYBERPUNK.SkillChipToggleHint"),
      expectedControlled: game.i18n.localize("CYBERPUNK.ControlledByChip"),
      boxPresent: !!boxOf(tipSkill.id),
      plainTitle: boxOf(tipSkill.id)?.getAttribute("title") ?? null,
      chipDrivenTitle: boxOf(tipChipSkill.id)?.getAttribute("title") ?? null,
      autoChippedDerived: !!actor.items.get(tipChipSkill.id)?.system?.autoChipped
    };
  } finally {
    ui.notifications.warn = warnWas;
    for (const it of worldItems) await it.delete().catch(() => {});
  }
  await actor.sheet.close().catch(() => {});
  await sleep(200);

  // ── cleanup ────────────────────────────────────────────────────────────────
  await actor.delete().catch(() => {});
  return out;
});

const P = [];
const chk = (name, ok, detail) => P.push({ name, ok: !!ok, detail });

// M1
chk("skill display-name helper reachable from our sheet's actor", r.m1.helperExists && !!r.m1.expectedDisplay, JSON.stringify(r.m1));
chk("skill row renders the resolved display name, not the raw name",
  r.m1.rendered === r.m1.expectedDisplay && r.m1.rendered !== r.m1.rawName,
  `rendered=${r.m1.rendered} expected=${r.m1.expectedDisplay} raw=${r.m1.rawName}`);
chk("skill search matches the display name", r.m1.hiddenForDisplayNameQuery === false, `hidden=${r.m1.hiddenForDisplayNameQuery}`);
chk("skill search still matches the raw name", r.m1.hiddenForRawNameQuery === false, `hidden=${r.m1.hiddenForRawNameQuery}`);
chk("skill search hides a non-matching row", r.m1.hiddenForMissQuery === true, `hidden=${r.m1.hiddenForMissQuery}`);

// M2/M3/M4 under both automation states — expectations measured off the base system's own sheet
for (const [key, lane] of Object.entries(r.chipLanes)) {
  const tag = `automation ${key.toUpperCase()}`;
  const S = (s) => JSON.stringify(s);

  chk(`${tag}: chip sheet renders with its activation checkbox`,
    lane.deactivate.sheetRendered && lane.deactivate.controlFound === true, S(lane.deactivate));
  chk(`${tag}: the stale seed really is stale before the gesture`,
    lane.deactivate.before.srcChipLevel === 9 && lane.deactivate.before.srcIsChipped === true && lane.deactivate.before.realSkillValue === 5,
    S(lane.deactivate.before));
  chk(`${tag}: unticking activation clears the persisted chip fields on the skill`,
    lane.deactivate.after.chipActive === false && lane.deactivate.after.srcChipLevel === 0
      && lane.deactivate.after.srcIsChipped === false && lane.deactivate.after.realSkillValue === 2,
    S(lane.deactivate.after));

  chk(`${tag}: unticking equipped forces the chip inactive and resyncs`,
    lane.unequip.controlFound === true && lane.unequip.after.equipped === false && lane.unequip.after.chipActive === false
      && lane.unequip.after.srcChipLevel === 0 && lane.unequip.after.srcIsChipped === false && lane.unequip.after.realSkillValue === 2,
    S(lane.unequip.after));

  chk(`${tag}: a chip-map level edit mirrors onto the skill's persisted level`,
    lane.levelEdit.controlFound === true && lane.levelEdit.after.mapValue === 0
      && lane.levelEdit.after.srcChipLevel === 0 && lane.levelEdit.after.srcIsChipped === true
      && lane.levelEdit.after.chipActive === true && lane.levelEdit.after.realSkillValue === 0,
    S(lane.levelEdit.after));

  chk(`${tag}: activating a clean chip drives the skill value without persisting chip fields`,
    lane.activate.controlFound === true && lane.activate.after.chipActive === true
      && lane.activate.after.srcChipLevel === 0 && lane.activate.after.srcIsChipped === false
      && lane.activate.after.realSkillValue === 5,
    S(lane.activate.after));

  for (const [name, sc] of Object.entries(lane).filter(([k]) => k !== "automationOn")) {
    chk(`${tag}: the grant layer left exactly one copy of the player's skill (${name})`, sc.skillItemCount === 1, `count=${sc.skillItemCount}`);
  }
}

// N1
chk("cyberwareType select present on the implant sheet", r.n1.selectPresent, "");
chk("cyberwareType CyberArm derives body type Arm and keeps the side",
  r.n1.afterArm.cyberwareType === "CyberArm" && r.n1.afterArm.bodyType === "Arm" && r.n1.afterArm.location === "Left",
  JSON.stringify(r.n1.afterArm));
chk("cyberwareType CyberOptic derives body type Head and clears the side",
  r.n1.afterOptic.cyberwareType === "CyberOptic" && r.n1.afterOptic.bodyType === "Head" && r.n1.afterOptic.location === "",
  JSON.stringify(r.n1.afterOptic));

// N2
chk("combat tab renders a fire row for an ENABLED cyberweapon", r.n2.enabledRow === true, JSON.stringify(r.n2));
chk("combat tab renders NO fire row for a DISABLED cyberweapon", r.n2.disabledRow === false, JSON.stringify(r.n2));
chk("enabling the cyberweapon makes its fire row appear", r.n2.disabledRowAfterEnable === true, JSON.stringify(r.n2));

// N3
chk("open implant sheet shows the slot readout", r.n3.slotsBefore === 3, JSON.stringify(r.n3));
chk("a sibling module slot bump refreshes the open implant sheet's slots left",
  r.n3.slotsAfterBump === 1, JSON.stringify(r.n3));

// ── S1 · skill-drop dedup guard ──────────────────────────────────────────────
const S1 = r.s1 ?? {};
const J1 = JSON.stringify(S1);
chk("dedup guard: the already-present notice key resolves", S1.hintKeyExists === true, J1);
chk("dedup guard: a hidden-until-searched skill row was located to drop onto", S1.hiddenSkillFound === true, J1);
chk("dedup guard: that row really is hidden before the drop", S1.hiddenBefore === true, J1);
chk("dedup guard: exactly one row carried the name before the drop", S1.countBefore === 1, J1);
chk("dedup guard: a same-name external drop creates NO second item", S1.countAfter === 1, J1);
chk("dedup guard: the drop posts the already-present notice",
  Array.isArray(S1.notices) && S1.notices.includes(S1.expectedNotice), J1);
chk("dedup guard: the existing row is revealed through the search reveal",
  S1.rowPresentAfter === true && S1.hiddenAfter === false && S1.searchValueAfter === S1.hiddenSkillName, J1);
chk("dedup guard: a plain skill row was located for the key-normalization leg", S1.plainSkillFound === true, J1);
chk("dedup guard: exactly one row carried the plain name before the drop", S1.varCountBefore === 1, J1);
chk("dedup guard: a case- and whitespace-varied same-name drop creates NO second item", S1.varCountAfter === 1, J1);
chk("dedup guard: NEGATIVE — an unheld skill name still embeds",
  S1.novelBefore === 0 && S1.novelAfter === 1, J1);
chk("dedup guard: NEGATIVE — an unheld skill drop posts no already-present notice",
  Array.isArray(S1.novelNotices) && S1.novelNotices.length === 0, J1);
chk("dedup guard: NEGATIVE — a non-skill drop is unaffected",
  S1.gearBefore === 0 && S1.gearAfter === 1, J1);

// ── S2 · search field separator ──────────────────────────────────────────────
const S2 = r.s2 ?? {};
const J2 = JSON.stringify(S2);
chk("search separator: the search box and the probe row both render",
  S2.searchPresent === true && S2.rowPresent === true, J2);
chk("search separator: the raw-name field still matches", S2.hiddenForRaw === false, J2);
chk("search separator: the display-name field still matches", S2.hiddenForDisplay === false, J2);
chk("search separator: a space cannot bridge the two fields", S2.hiddenForSpaceBridge === true, J2);
chk("search separator: the separator character pasted into the query cannot bridge them",
  S2.hiddenForSeparatorBridge === true, J2);
chk("search separator: a hidden discipline stays hidden with an empty query",
  S2.hiddenSkillHiddenWithNoQuery === true, J2);
chk("search separator: its known query reveals it", S2.hiddenSkillRevealedByQuery === true, J2);

// ── S3 · chip-toggle tooltip ─────────────────────────────────────────────────
const S3 = r.s3 ?? {};
const J3 = JSON.stringify(S3);
chk("chip-toggle tooltip: the hint key resolves", S3.hintKeyExists === true, J3);
chk("chip-toggle tooltip: the row's checkbox renders", S3.boxPresent === true, J3);
chk("chip-toggle tooltip: the checkbox carries the localized hint as its title",
  !!S3.expectedHint && S3.plainTitle === S3.expectedHint, J3);
chk("chip-toggle tooltip: the hint is real text, not an unresolved key",
  typeof S3.expectedHint === "string" && !S3.expectedHint.startsWith("CYBERPUNK.")
    && S3.expectedHint.length > 20 && /chip level/i.test(S3.expectedHint), J3);
chk("chip-toggle tooltip: a chip-driven row is derived as chip-controlled", S3.autoChippedDerived === true, J3);
chk("chip-toggle tooltip: a chip-driven row keeps its controlled-by-chip title",
  S3.chipDrivenTitle === S3.expectedControlled, J3);

chk("0 console errors", errors.length === 0, errors.slice(0, 6).join(" | "));

let fail = 0;
for (const c of P) { if (!c.ok) fail++; console.log(`${c.ok ? "PASS" : "FAIL"} — ${c.name}${c.ok ? "" : "  [" + c.detail + "]"}`); }
console.log(`\n${P.length - fail}/${P.length} checks passed`);
await b.close();
process.exit(fail ? 1 : 0);
