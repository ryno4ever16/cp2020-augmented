/**
 * KEEPER: the vehicle sheet-face picker.
 *
 *  The escape it exists against: the face controls used to be scattered checkboxes, and the MM
 *  combat face carried NO control that clears the MM designation — selecting that face was one-way.
 *  A presence leg would not have caught it; every leg here asserts an OUTCOME by value.
 *
 *  Sections
 *    A  resolver values — the designation pair each option writes, what a stored pair designates,
 *       and what a catalog vehicle's own data derives
 *    B  rendered geometry — the strip is the FIRST content row, above the header, on all three
 *       faces, at two window widths (the sheet is resizable)
 *    C  provenance + derivation — EVERY vehicle offers the picker (2026-08-25 ruling); derivation
 *       only chooses the DEFAULT selection, a stored designation is never re-derived, and a pick on
 *       a derived vehicle records it
 *    D  the world gate — the MM option stays VISIBLE and disabled with a hint naming the setting
 *    E  the ACPA boundary — confirm on entry AND on exit, cancel writes nothing, confirm writes
 *       BOTH booleans in ONE update; Standard<->MM flips free and preserves the MM data
 *    F  the MM-data note — appears under exactly its three conditions and never otherwise
 *    G  the same control on the vehicle ITEM sheet — resolver, rendered strip, the atomic write of
 *       the item's own pair, the ACPA confirm, and what a deploy from that item then seeds
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const SHOT_DIR = process.env.SHOT_DIR ?? ".";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(m.text())) errors.push(m.text()); });
page.on("pageerror", e => errors.push(e.message));

await page.goto(`${URL}/join`);
await page.waitForSelector('select[name="userid"]');
await page.evaluate(() => {
  const sel = document.querySelector('select[name="userid"]');
  sel.value = [...sel.options].find(o => /gamemaster/i.test(o.textContent)).value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.fill('input[name="password"]', PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 60000 });

const res = await page.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  const VEH = `${SCOPE}.vehicle`;
  const out = { checks: [], made: [], items: [] };
  const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const F = await import(`/modules/${SCOPE}/module/vehicle/vehicle-face.js`);
  const D = await import(`/modules/${SCOPE}/module/vehicle/vehicle-deploy-request.js`);

  const mmWas = game.settings.get(SCOPE, "mmEnabled");
  const ruleWas = game.settings.get(SCOPE, "vehicleRuleSystem");
  for (const a of [...game.actors]) if (a.name.startsWith("__PWF__")) await a.delete();
  for (const i of [...game.items]) if (i.name.startsWith("__PWF__")) await i.delete();

  const mk = async (name, system = {}, flags = undefined) => {
    const a = await Actor.create({ name, type: VEH, system, ...(flags ? { flags } : {}) });
    out.made.push(a.id);
    return a;
  };
  const open = async (a) => { await a.sheet.render(true); await sleep(750); return a.sheet.element; };
  const strip = (root) => root?.querySelector(".cp-veh-face-strip");
  const sel = (root) => root?.querySelector("select.cp-veh-face-select");

  try {
    // ══ A — resolver values ════════════════════════════════════════════════════════════════
    const CHOSE = `flags.${SCOPE}.faceChosen`;
    ok("A pair written by Standard is false/false",
      F.facePatch("standard")["system.isACPA"] === false
      && F.facePatch("standard")["system.isMMVehicle"] === false,
      JSON.stringify(F.facePatch("standard")));
    ok("A pair written by Maximum Metal is false/true",
      F.facePatch("mm")["system.isACPA"] === false && F.facePatch("mm")["system.isMMVehicle"] === true,
      JSON.stringify(F.facePatch("mm")));
    ok("A pair written by ACPA is true/false",
      F.facePatch("acpa")["system.isACPA"] === true && F.facePatch("acpa")["system.isMMVehicle"] === false,
      JSON.stringify(F.facePatch("acpa")));
    // ⭐ THE THIRD STATE. Two false booleans cannot say "Standard" — they are also what a vehicle
    // nobody has touched carries — so every pick also records that it WAS a pick, in the same
    // single update. Without it, picking Standard on a tank was a no-op the derivation undid.
    ok("A every pick also records that a human made it, in the SAME update",
      ["standard", "mm", "acpa"].every(f => F.facePatch(f)[CHOSE] === true),
      JSON.stringify(F.facePatch("standard")));
    ok("A a pick is still ONE update — three keys, no second write",
      Object.keys(F.facePatch("standard")).length === 3, JSON.stringify(Object.keys(F.facePatch("standard"))));
    ok("A NEGATIVE: an untouched document has no explicit face at all",
      F.explicitFace({ system: { isACPA: false, isMMVehicle: false } }) === "");
    ok("A a document carrying the choice flag and a false pair explicitly means Standard",
      F.explicitFace({ system: { isACPA: false, isMMVehicle: false }, flags: { [SCOPE]: { faceChosen: true } } }) === "standard");
    ok("A a stored true still designates without needing the flag",
      F.explicitFace({ system: { isACPA: false, isMMVehicle: true } }) === "mm");
    ok("A both-false pair designates nothing", F.designatedFace({ isACPA: false, isMMVehicle: false }) === "");
    ok("A a stored MM flag designates the MM face", F.designatedFace({ isACPA: false, isMMVehicle: true }) === "mm");
    ok("A a stored ACPA flag designates the ACPA face", F.designatedFace({ isACPA: true, isMMVehicle: false }) === "acpa");
    ok("A a legacy both-true pair resolves to ACPA, not MM",
      F.designatedFace({ isACPA: true, isMMVehicle: true }) === "acpa", F.designatedFace({ isACPA: true, isMMVehicle: true }));
    ok("A derived: tank -> MM", F.derivedFace({ vehicleType: "tank", vehicleTypeText: "Tank" }) === "mm");
    ok("A derived: APC -> MM", F.derivedFace({ vehicleType: "APC", vehicleTypeText: "APC" }) === "mm");
    ok("A derived: powered armor by class string -> ACPA",
      F.derivedFace({ vehicleType: "car", vehicleTypeText: "ACPA (Powered Armor)" }) === "acpa");
    ok("A derived NEGATIVE: car -> Standard", F.derivedFace({ vehicleType: "car", vehicleTypeText: "Sedan" }) === "standard");
    ok("A derived NEGATIVE: truck -> Standard", F.derivedFace({ vehicleType: "truck", vehicleTypeText: "Truck" }) === "standard");
    ok("A derived NEGATIVE: no class recorded -> Standard", F.derivedFace({}) === "standard");

    await game.settings.set(SCOPE, "mmEnabled", true);
    await game.settings.set(SCOPE, "vehicleRuleSystem", "MaximumMetal");

    // ══ B — rendered geometry, all three faces, two widths ═════════════════════════════════
    const custStd  = await mk("__PWF__CustStd",  { sp: { front: 10 } });
    const custMM   = await mk("__PWF__CustMM",   { isMMVehicle: true, sp: { front: 20, side: 18 } });
    const custACPA = await mk("__PWF__CustACPA", { isACPA: true, str: 25 });

    const geometry = async (a, faceName, expectValue) => {
      const root = await open(a);
      const st = strip(root), sl = sel(root);
      const header = root.querySelector("header.cyberheader");
      ok(`B ${faceName}: face strip renders`, !!st);
      ok(`B ${faceName}: picker renders with the face in force selected`, sl?.value === expectValue, `value=${sl?.value}`);
      ok(`B ${faceName}: all three options offered`, sl?.options?.length === 3, `${sl?.options?.length}`);
      // The wrapper part and each face template BOTH carry `.cp-vehicle-sheet-root`, so a plain
      // querySelector finds the wrapper. Read the container off the strip itself: it must be the
      // face template's own root, and the strip must be that root's first element.
      const sheetRoot = st?.parentElement;
      ok(`B ${faceName}: the strip is the FIRST content row of the face`,
        !!sheetRoot?.matches?.(".cp-vehicle-sheet-root, .cp-acpa-sheet-root") && sheetRoot.firstElementChild === st,
        `${sheetRoot?.className} / first=${sheetRoot?.firstElementChild?.className}`);
      const sr = st?.getBoundingClientRect(), hr = header?.getBoundingClientRect();
      ok(`B ${faceName}: the strip sits ABOVE the header`, sr && hr && sr.top < hr.top,
        `strip top ${Math.round(sr?.top)} vs header top ${Math.round(hr?.top)}`);
      const cs = getComputedStyle(st);
      ok(`B ${faceName}: the strip is fixed-height (not equal-grown by .flexcol)`,
        cs.flexGrow === "0" && cs.flexShrink === "0", `flex ${cs.flexGrow} ${cs.flexShrink} ${cs.flexBasis}`);
      // two-width probe — a resizable sheet: narrow, then wide.
      const widths = [];
      for (const w of [430, 900]) {
        a.sheet.setPosition({ width: w });
        await sleep(350);
        const r2 = a.sheet.element;
        const st2 = strip(r2), sl2 = sel(r2), lb2 = r2.querySelector(".cp-veh-face-label");
        const h2 = r2.querySelector("header.cyberheader");
        widths.push({
          w,
          aboveHeader: st2.getBoundingClientRect().top < h2.getBoundingClientRect().top,
          labelClipped: lb2.scrollWidth > lb2.clientWidth + 1,
          selectInside: sl2.getBoundingClientRect().right <= st2.getBoundingClientRect().right + 1,
          stripInside: st2.getBoundingClientRect().width <= r2.getBoundingClientRect().width + 1,
        });
      }
      ok(`B ${faceName}: strip holds at 430px AND 900px (above header, label unclipped, control contained)`,
        widths.every(x => x.aboveHeader && !x.labelClipped && x.selectInside && x.stripInside),
        JSON.stringify(widths));
      a.sheet.setPosition({ width: 600 });
      await sleep(250);
    };
    await geometry(custStd, "standard face", "standard");
    await geometry(custMM, "MM combat face", "mm");
    await geometry(custACPA, "ACPA face", "acpa");
    out.shotId = custStd.sheet.id;
    for (const a of [custMM, custACPA]) await a.sheet.close();

    // ══ C — provenance + derivation ═══════════════════════════════════════════════════════
    const pack = game.packs.get("cyberpunk2020.vehicles");
    const idx = await pack.getIndex({ fields: ["type"] });
    const packItem = await pack.getDocument(idx.find(e => e.type === "vehicle")._id);

    // C1 the REAL deploy path: does it stamp a provenance this resolver can read?
    const deployed = await D.createVehicleActorFromItem(packItem, { name: "__PWF__Deployed" });
    out.made.push(deployed.id);
    ok("C deploy stamps a resolvable compendium provenance",
      F.isCatalogVehicle(deployed) === true, JSON.stringify(F.vehiclePackSource(deployed)));
    const dr = await open(deployed);
    // ⭐ 2026-08-25 RULING: the picker is offered on EVERY vehicle sheet. This leg asserted the
    // opposite for the whole life of the control.
    ok("C a compendium-deployed vehicle DOES offer the picker", !!sel(dr) && !!strip(dr));
    ok("C the resolver reports the picker as offered even for catalog provenance",
      F.resolveVehicleFace(deployed, { mmOn: true }).showPicker === true);
    await deployed.sheet.close();

    // C2 the owned-copy chain: actor -> world item copy -> its _stats.compendiumSource -> pack.
    const owned = await Item.create({ name: "__PWF__OwnedCopy", type: "vehicle",
      _stats: { compendiumSource: packItem.uuid } });
    out.items.push(owned.id);
    const viaOwned = await mk("__PWF__ViaOwned", { vehicleType: "tank", vehicleTypeText: "Tank" },
      { [SCOPE]: { sourceItemUuid: owned.uuid, createdBy: game.user.id } });
    ok("C provenance resolves through an owned copy's compendiumSource",
      F.isCatalogVehicle(viaOwned) === true, JSON.stringify(F.vehiclePackSource(viaOwned)));
    let r = await open(viaOwned);
    ok("C catalog tank offers the picker, showing the derived face as the selection",
      !!sel(r) && sel(r).value === "mm", sel(r)?.value);
    ok("C catalog tank derives the MM combat face", !!r.querySelector('input[name="system.sp.side"]'));
    ok("C catalog tank does NOT write a designation (stored pair untouched)",
      viaOwned.system.isMMVehicle === false && viaOwned.system.isACPA === false,
      `${viaOwned.system.isACPA}/${viaOwned.system.isMMVehicle}`);
    ok("C a derived-only selection says so on the strip",
      !!r.querySelector(".cp-veh-face-derived"));

    // NEGATIVE: same provenance, a class that derives nothing special -> the standard face.
    const viaOwnedCar = await mk("__PWF__ViaOwnedCar", { vehicleType: "car", vehicleTypeText: "Sedan", sp: { front: 10 } },
      { [SCOPE]: { sourceItemUuid: owned.uuid, createdBy: game.user.id } });
    let rc = await open(viaOwnedCar);
    ok("C catalog car derives the standard face and offers the picker on it",
      !!rc.querySelector('input[name="system.speedValue"]') && !!sel(rc) && sel(rc).value === "standard",
      sel(rc)?.value);

    // ⭐ THE VEHICLE THE OLD RULE FAILED HARDEST ON: a hand-built tank, no provenance at all.
    // Derivation is now the default selection for it too, and the picker was always offered.
    const customTank = await mk("__PWF__CustomTank", { vehicleType: "tank", vehicleTypeText: "Tank", sp: { front: 30 } });
    const ctr = await open(customTank);
    ok("C a CUSTOM tank defaults to the MM combat face and can be moved off it",
      !!sel(ctr) && sel(ctr).value === "mm" && !!ctr.querySelector('input[name="system.sp.side"]'),
      sel(ctr)?.value);
    ok("C that default wrote nothing", customTank.system.isMMVehicle === false && customTank.system.isACPA === false,
      `${customTank.system.isACPA}/${customTank.system.isMMVehicle}`);
    await customTank.sheet.close();

    // The world gate applies to a DERIVED MM face too.
    await game.settings.set(SCOPE, "mmEnabled", false);
    r = await open(viaOwned);
    ok("C catalog tank falls back to the standard face when Maximum Metal is off",
      !!r.querySelector('input[name="system.speedValue"]') && !r.querySelector('input[name="system.sp.side"]'));
    await game.settings.set(SCOPE, "mmEnabled", true);

    // A STORED designation on a catalog vehicle stays authoritative over the derivation.
    const packStored = await mk("__PWF__PackStored", { vehicleType: "car", vehicleTypeText: "Sedan", isMMVehicle: true },
      { [SCOPE]: { sourceItemUuid: packItem.uuid, createdBy: game.user.id } });
    const psr = await open(packStored);
    ok("C a stored designation beats the derivation on a catalog vehicle",
      !!psr.querySelector('input[name="system.sp.side"]') && !!sel(psr) && sel(psr).value === "mm",
      sel(psr)?.value);
    ok("C a STORED designation raises no derived-only note",
      !psr.querySelector(".cp-veh-face-derived"));
    await packStored.sheet.close();

    // NEGATIVE: a source item with no compendium origin at all = a custom vehicle, picker shown.
    const loose = await Item.create({ name: "__PWF__LooseItem", type: "vehicle" });
    out.items.push(loose.id);
    const viaLoose = await mk("__PWF__ViaLoose", { vehicleType: "tank", vehicleTypeText: "Tank" },
      { [SCOPE]: { sourceItemUuid: loose.uuid, createdBy: game.user.id } });
    ok("C NEGATIVE: a non-compendium source item is not catalog provenance",
      F.isCatalogVehicle(viaLoose) === false);
    const vlr = await open(viaLoose);
    // Its class still derives the combat face — derivation no longer depends on provenance — but
    // the point of this leg is that the loose source item is NOT catalog provenance.
    ok("C NEGATIVE: that vehicle keeps its picker, defaulted from its own class",
      !!sel(vlr) && sel(vlr).value === "mm" && !!vlr.querySelector(".cp-veh-face-derived"),
      sel(vlr)?.value);

    // ⭐ REVERSIBLE ON A CATALOG VEHICLE — the whole point of the ruling. Drive the real control on
    // the deployed tank and read the stored pair back.
    // Fail-SOFT: on a build with no picker on this face the legs below must go RED with a readable
    // detail, not take the whole evaluate down and cost the run its tally.
    const catalogPick = async (a, value) => {
      const s = sel(a.sheet.element);
      if (!s) return false;
      s.value = value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(450);
      return true;
    };
    await open(viaOwned);
    const pick1 = await catalogPick(viaOwned, "standard");
    // ⭐ THE ONE-WAY DOOR. Standard is the option whose stored bytes are indistinguishable from
    // "untouched", so on a vehicle whose class derives Maximum Metal this is the pick that used to
    // bounce straight back. It must RECORD, and the civilian layout must actually render.
    ok("C picking Standard on a catalog tank RECORDS it and the civilian layout renders",
      pick1 && viaOwned.system.isMMVehicle === false && viaOwned.system.isACPA === false
      && F.explicitFace(viaOwned) === "standard"
      && !!viaOwned.sheet.element.querySelector('input[name="system.speedValue"]')
      && !viaOwned.sheet.element.querySelector(".cp-veh-face-derived"),
      pick1 ? `${viaOwned.system.isACPA}/${viaOwned.system.isMMVehicle} explicit=${F.explicitFace(viaOwned)}` : "no picker on the sheet");
    const pick2 = await catalogPick(viaOwned, "mm");
    ok("C and back again — the catalog vehicle is not one-way",
      pick2 && viaOwned.system.isMMVehicle === true
      && !!viaOwned.sheet.element.querySelector('input[name="system.sp.side"]'),
      pick2 ? `${viaOwned.system.isACPA}/${viaOwned.system.isMMVehicle}` : "no picker on the sheet");
    await viaOwned.update({ "system.isMMVehicle": false, "system.isACPA": false,
      [`flags.${SCOPE}.-=faceChosen`]: null });
    for (const a of [viaOwned, viaOwnedCar, viaLoose]) await a.sheet.close();

    // ══ D — the world gate on the MM option ═══════════════════════════════════════════════
    await game.settings.set(SCOPE, "mmEnabled", false);
    let sr = await open(custStd);
    let mmOpt = [...sel(sr).options].find(o => o.value === "mm");
    ok("D Core world: the MM option is still VISIBLE (offered, not removed)",
      !!mmOpt && [...sel(sr).options].length === 3);
    ok("D Core world: the MM option is DISABLED", mmOpt?.disabled === true);
    const hint = sr.querySelector(".cp-veh-face-hint");
    ok("D Core world: a hint renders and names the world setting",
      !!hint && /Vehicles: Rule System/.test(hint.textContent), hint?.textContent?.trim());
    ok("D Core world: Standard and ACPA stay selectable",
      [...sel(sr).options].filter(o => !o.disabled).map(o => o.value).join(",") === "standard,acpa");
    await game.settings.set(SCOPE, "mmEnabled", true);
    sr = await open(custStd);
    mmOpt = [...sel(sr).options].find(o => o.value === "mm");
    ok("D NEGATIVE: with Maximum Metal on the MM option is enabled and the hint is gone",
      mmOpt?.disabled === false && !sr.querySelector(".cp-veh-face-hint"));

    // ══ E — the ACPA boundary + the free Standard<->MM flip ═══════════════════════════════
    // One update per face change: record the change payloads a pick produces.
    const seen = [];
    const hookId = Hooks.on("preUpdateActor", (doc, changes) => {
      if (doc.name?.startsWith("__PWF__")) seen.push({ actor: doc.name, sys: foundry.utils.deepClone(changes.system ?? {}) });
    });
    const pick = async (a, value) => {
      const root = a.sheet.element;
      const s = sel(root);
      s.value = value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(400);
    };
    const answer = async (which) => {
      let btn = null;
      for (let i = 0; i < 40 && !btn; i++) { await sleep(100); btn = document.querySelector(`.application.dialog button[data-action="${which}"]`); }
      btn?.click();
      await sleep(700);
      return !!btn;
    };
    const dialogUp = async () => {
      for (let i = 0; i < 10; i++) { await sleep(100); if (document.querySelector('.application.dialog button[data-action="yes"]')) return true; }
      return false;
    };

    // E1 Standard -> MM: no confirm, MM data preserved.
    const flip = await mk("__PWF__Flip", { sp: { front: 20, side: 18, rear: 16, top: 14, bottom: 12 }, sdp: { value: 50, max: 50 } });
    await open(flip);
    seen.length = 0;
    await pick(flip, "mm");
    ok("E Standard->MM asks nothing", (await dialogUp()) === false);
    ok("E Standard->MM writes the pair in ONE update",
      seen.length === 1 && seen[0].sys.isACPA === false && seen[0].sys.isMMVehicle === true,
      JSON.stringify(seen));
    ok("E Standard->MM lands the designation", flip.system.isMMVehicle === true && flip.system.isACPA === false);
    await sleep(400);
    await pick(flip, "standard");
    ok("E MM->Standard asks nothing and clears the designation",
      flip.system.isMMVehicle === false && flip.system.isACPA === false,
      `${flip.system.isACPA}/${flip.system.isMMVehicle}`);
    ok("E the round trip preserved every facing SP",
      JSON.stringify(flip.system.sp) === JSON.stringify({ front: 20, side: 18, rear: 16, top: 14, bottom: 12 }),
      JSON.stringify(flip.system.sp));

    // E2 Standard -> ACPA, CANCELLED: nothing is written.
    seen.length = 0;
    await pick(flip, "acpa");
    const cancelDlg = await answer("no");
    ok("E Standard->ACPA raises a confirm", cancelDlg === true);
    ok("E CANCEL writes nothing", seen.length === 0 && flip.system.isACPA === false && flip.system.isMMVehicle === false,
      `updates=${seen.length} ${flip.system.isACPA}/${flip.system.isMMVehicle}`);
    await sleep(400);
    ok("E CANCEL leaves the control on the face still in force", sel(flip.sheet.element)?.value === "standard",
      sel(flip.sheet.element)?.value);

    // E3 Standard -> ACPA, CONFIRMED: both booleans in ONE update.
    seen.length = 0;
    await pick(flip, "acpa");
    await answer("yes");
    ok("E CONFIRM writes BOTH booleans in a single update",
      seen.length === 1 && seen[0].sys.isACPA === true && seen[0].sys.isMMVehicle === false,
      JSON.stringify(seen));
    ok("E CONFIRM lands the ACPA face", flip.system.isACPA === true
      && !!flip.sheet.element.querySelector('input[name="system.str"]'));

    // E4 leaving ACPA also confirms (the boundary is crossed in BOTH directions).
    seen.length = 0;
    await pick(flip, "standard");
    ok("E ACPA->Standard raises a confirm too", (await answer("yes")) === true);
    ok("E ACPA->Standard clears the suit designation in one update",
      seen.length === 1 && seen[0].sys.isACPA === false && seen[0].sys.isMMVehicle === false,
      JSON.stringify(seen));
    Hooks.off("preUpdateActor", hookId);
    await flip.sheet.close();

    // ══ F — the civilian-face MM-data note ════════════════════════════════════════════════
    const noteOf = async (a) => { const root = await open(a); return root.querySelector(".cp-veh-mm-data-note"); };
    await game.settings.set(SCOPE, "vehicleRuleSystem", "MaximumMetal");
    const carrier = await mk("__PWF__Carrier", { sp: { front: 20, side: 18 } });
    ok("F standard face + MM rules + flank armor: the note renders", !!(await noteOf(carrier)));
    const bare = await mk("__PWF__Bare", { sp: { front: 20 } });
    ok("F NEGATIVE: no combat data beyond the front SP -> no note", !(await noteOf(bare)));
    await game.settings.set(SCOPE, "vehicleRuleSystem", "Core");
    ok("F NEGATIVE: same carrier under Core rules -> no note", !(await noteOf(carrier)));
    await game.settings.set(SCOPE, "vehicleRuleSystem", "MaximumMetal");
    await carrier.update({ "system.isMMVehicle": true });
    ok("F NEGATIVE: the MM combat face is not the standard face -> no note", !(await noteOf(carrier)));
    await carrier.update({ "system.isMMVehicle": false });
    // A mounted weapon is combat data too, with every facing at zero.
    const mounts = await mk("__PWF__Mounts", { sp: { front: 0 } });
    await mounts.createEmbeddedDocuments("Item", [{ name: "__PWF__Gun", type: `${SCOPE}.vehicleWeapon` }]);
    ok("F a mounted weapon alone raises the note", !!(await noteOf(mounts)));
    ok("F resolver NEGATIVE: an empty vehicle carries no MM combat data", F.carriesMMCombatData(bare) === false);
    for (const a of [carrier, bare, mounts]) await a.sheet.close();

    // ══ G — the same control on the vehicle ITEM (the pink slip) ══════════════════════════
    await game.settings.set(SCOPE, "mmEnabled", true);

    // G1 resolver: the item's own class derives a default, its stored pair overrides it.
    // Fail-SOFT on a build that has no item-side resolver at all — these must RED, not throw.
    const itemFace = (sys) => {
      try { return F.resolveVehicleItemFace({ system: sys }); }
      catch (e) { return { chosen: "", stored: null, derived: "" }; }
    };
    ok("G item resolver: no class recorded -> Standard is the default selection",
      itemFace({}).chosen === "standard", itemFace({}).chosen);
    ok("G item resolver: a class string of Tank -> the MM face is the default",
      itemFace({ vehicleType: "Tank" }).chosen === "mm", itemFace({ vehicleType: "Tank" }).chosen);
    ok("G item resolver: powered armor by class string -> the ACPA face is the default",
      itemFace({ vehicleType: "ACPA (Powered Armor)" }).chosen === "acpa");
    ok("G item resolver: a STORED pair beats the class",
      itemFace({ vehicleType: "Tank", isMMVehicle: false, isACPA: false }).stored === ""
      && itemFace({ vehicleType: "Tank", isMMVehicle: true }).stored === "mm");

    // G2 the ITEM carries the pair at all — the schema addition, by value.
    const vItem = await Item.create({ name: "__PWF__PinkSlip", type: "vehicle",
      system: { vehicleType: "Sedan", crew: 1, passengers: 3 } });
    out.items.push(vItem.id);
    ok("G a vehicle item stores the designation pair, both false out of the box",
      vItem.system.isACPA === false && vItem.system.isMMVehicle === false,
      `${vItem.system.isACPA}/${vItem.system.isMMVehicle}`);

    // G3 the rendered strip, on the item sheet.
    await vItem.sheet.render(true);
    await sleep(900);
    const ir = vItem.sheet.element;
    const iStrip = ir.querySelector(".cp-veh-face-strip");
    const iSel = ir.querySelector("select.cp-veh-face-select");
    ok("G the item sheet renders the face strip", !!iStrip);
    ok("G it offers all three faces, defaulted from the item's class",
      iSel?.options?.length === 3 && iSel?.value === "standard", `${iSel?.options?.length} / ${iSel?.value}`);
    ok("G the strip is the FIRST row of the settings tab, above the fields",
      !!iStrip && iStrip.parentElement?.querySelector(".cp-veh-face-strip, .cp-vehicle-item-fields") === iStrip);
    // Separate from the other checkboxes: the strip is not inside a .field-list at all.
    ok("G the control sits in its own band, not among the field rows",
      !!iStrip && !iStrip.closest(".field-list") && !iStrip.closest(".field"));
    const iLabel = ir.querySelector(".cp-veh-face-label");
    ok("G the strip's label is not clipped at the sheet's default width",
      !!iLabel && iLabel.scrollWidth <= iLabel.clientWidth + 1,
      `${iLabel?.scrollWidth} vs ${iLabel?.clientWidth}`);
    ok("G nothing recorded yet, so the strip says the selection is derived",
      !!ir.querySelector(".cp-veh-face-derived"));

    // G4 the write: ONE update carrying BOTH booleans, from the one table.
    const itemSeen = [];
    const iHook = Hooks.on("preUpdateItem", (doc, changes) => {
      if (doc.name?.startsWith("__PWF__")) itemSeen.push(foundry.utils.deepClone(changes.system ?? {}));
    });
    const pickItem = async (value) => {
      const s = vItem.sheet.element.querySelector("select.cp-veh-face-select");
      if (!s) return false;
      s.value = value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(500);
      return true;
    };
    const gotPicker = await pickItem("mm");
    ok("G Standard->MM on the item writes the pair in ONE update",
      gotPicker && itemSeen.length === 1 && itemSeen[0].isACPA === false && itemSeen[0].isMMVehicle === true,
      gotPicker ? JSON.stringify(itemSeen) : "no picker on the item sheet");
    ok("G the item's stored pair lands", vItem.system.isMMVehicle === true && vItem.system.isACPA === false);
    await sleep(300);
    ok("G the strip stops calling the selection derived once it is recorded",
      !vItem.sheet.element.querySelector(".cp-veh-face-derived"));

    // G5 REVERSIBLE, and the ACPA boundary confirms here too.
    itemSeen.length = 0;
    await pickItem("standard");
    ok("G MM->Standard on the item clears the designation, no prompt",
      vItem.system.isMMVehicle === false && vItem.system.isACPA === false && itemSeen.length === 1,
      `${vItem.system.isACPA}/${vItem.system.isMMVehicle} updates=${itemSeen.length}`);
    itemSeen.length = 0;
    await pickItem("acpa");
    ok("G Standard->ACPA on the item raises a confirm", (await dialogUp()) === true);
    await answer("no");
    ok("G CANCEL on the item writes nothing",
      itemSeen.length === 0 && vItem.system.isACPA === false,
      `updates=${itemSeen.length} isACPA=${vItem.system.isACPA}`);
    itemSeen.length = 0;
    await pickItem("acpa");
    await answer("yes");
    ok("G CONFIRM on the item writes BOTH booleans in one update",
      itemSeen.length === 1 && itemSeen[0].isACPA === true && itemSeen[0].isMMVehicle === false,
      JSON.stringify(itemSeen));
    Hooks.off("preUpdateItem", iHook);
    out.itemShotId = vItem.sheet.id;

    // G6 WHAT THE DEPLOY THEN DOES — the reason the control is on the item at all.
    const fromAcpaItem = await D.createVehicleActorFromItem(vItem, { name: "__PWF__FromACPAItem" });
    out.made.push(fromAcpaItem.id);
    ok("G a deploy seeds the actor from the ITEM's designation",
      fromAcpaItem.system.isACPA === true && fromAcpaItem.system.isMMVehicle === false,
      `${fromAcpaItem.system.isACPA}/${fromAcpaItem.system.isMMVehicle}`);
    await vItem.update(F.facePatch("mm"));
    const fromMMItem = await D.createVehicleActorFromItem(vItem, { name: "__PWF__FromMMItem" });
    out.made.push(fromMMItem.id);
    ok("G a pink slip marked Maximum Metal deploys onto the MM combat face",
      fromMMItem.system.isMMVehicle === true && fromMMItem.system.isACPA === false,
      `${fromMMItem.system.isACPA}/${fromMMItem.system.isMMVehicle}`);
    // NEGATIVE / regression: an item that designates NOTHING seeds exactly what it always did.
    const plainItem = await Item.create({ name: "__PWF__PlainSlip", type: "vehicle",
      system: { vehicleType: "Sedan" } });
    out.items.push(plainItem.id);
    const fromPlain = await D.createVehicleActorFromItem(plainItem, { name: "__PWF__FromPlain" });
    out.made.push(fromPlain.id);
    ok("G NEGATIVE: an undesignated pink slip still deploys onto the standard face",
      fromPlain.system.isACPA === false && fromPlain.system.isMMVehicle === false,
      `${fromPlain.system.isACPA}/${fromPlain.system.isMMVehicle}`);

    // ⭐ THE AMBIGUOUS CASE, END TO END: a TANK pink slip whose GM picked Standard. Its stored pair
    // is the same two false booleans an untouched item carries, so only the choice flag stops the
    // class derivation putting the deployed vehicle back on the combat sheet.
    const tankItem = await Item.create({ name: "__PWF__TankSlip", type: "vehicle",
      system: { vehicleType: "Tank" } });
    out.items.push(tankItem.id);
    const tankDefault = await D.createVehicleActorFromItem(tankItem, { name: "__PWF__TankDefault" });
    out.made.push(tankDefault.id);
    const tankDefaultFace = F.resolveVehicleFace(tankDefault, { mmOn: true }).face;
    await tankItem.update(F.facePatch("standard"));
    ok("G a tank slip marked Standard records the choice its two booleans cannot express",
      F.explicitFace(tankItem) === "standard" && tankItem.system.isMMVehicle === false,
      `explicit=${F.explicitFace(tankItem)} pair=${tankItem.system.isACPA}/${tankItem.system.isMMVehicle}`);
    const tankStd = await D.createVehicleActorFromItem(tankItem, { name: "__PWF__TankStd" });
    out.made.push(tankStd.id);
    ok("G …and a vehicle deployed from it opens on the STANDARD face, not the class-derived one",
      F.resolveVehicleFace(tankStd, { mmOn: true }).face === "standard",
      F.resolveVehicleFace(tankStd, { mmOn: true }).face);
    ok("G CONTROL: the same slip UNmarked deploys onto the class-derived combat face",
      tankDefaultFace === "mm", tankDefaultFace);
    // Left OPEN on purpose: the screenshot for the user's sign-off is taken from Node after this
    // evaluate returns, and the cleanup pass at the very end closes and deletes it.
    await vItem.sheet.render(true);
    await sleep(600);
  } finally {
    await game.settings.set(SCOPE, "mmEnabled", mmWas);
    await game.settings.set(SCOPE, "vehicleRuleSystem", ruleWas);
  }
  return out;
});

for (const c of res.checks) check(c.n, c.p, c.d);

// screenshot the strip for the user's eye (aesthetics are the user's call)
if (res.shotId) {
  await page.locator(`#${res.shotId}`).screenshot({ path: `${SHOT_DIR}/veh-face-strip.png` }).catch(() => {});
}
if (res.itemShotId) {
  await page.locator(`#${res.itemShotId}`).screenshot({ path: `${SHOT_DIR}/veh-item-face-strip.png` }).catch(() => {});
}

await page.evaluate(async ({ made, items }) => {
  for (const id of made) { const a = game.actors.get(id); await a?.sheet?.close(); await a?.delete().catch(() => {}); }
  for (const id of items) {
    const i = game.items.get(id);
    await i?.sheet?.close().catch(() => {});
    await i?.delete().catch(() => {});
  }
  const f = game.folders.find(x => x.type === "Actor" && x.name === "Vehicles");
  if (f && f.contents.length === 0) await f.delete().catch(() => {});
}, res);

check("0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
