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
 *    C  provenance — a compendium-deployed vehicle shows NO picker and derives its face; a custom
 *       one shows the picker; a stored designation is never re-derived
 *    D  the world gate — the MM option stays VISIBLE and disabled with a hint naming the setting
 *    E  the ACPA boundary — confirm on entry AND on exit, cancel writes nothing, confirm writes
 *       BOTH booleans in ONE update; Standard<->MM flips free and preserves the MM data
 *    F  the MM-data note — appears under exactly its three conditions and never otherwise
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
    ok("A pair written by Standard is false/false",
      JSON.stringify(F.facePatch("standard")) === JSON.stringify({ "system.isACPA": false, "system.isMMVehicle": false }),
      JSON.stringify(F.facePatch("standard")));
    ok("A pair written by Maximum Metal is false/true",
      JSON.stringify(F.facePatch("mm")) === JSON.stringify({ "system.isACPA": false, "system.isMMVehicle": true }),
      JSON.stringify(F.facePatch("mm")));
    ok("A pair written by ACPA is true/false",
      JSON.stringify(F.facePatch("acpa")) === JSON.stringify({ "system.isACPA": true, "system.isMMVehicle": false }),
      JSON.stringify(F.facePatch("acpa")));
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

    // ══ C — provenance ════════════════════════════════════════════════════════════════════
    const pack = game.packs.get("cyberpunk2020.vehicles");
    const idx = await pack.getIndex({ fields: ["type"] });
    const packItem = await pack.getDocument(idx.find(e => e.type === "vehicle")._id);

    // C1 the REAL deploy path: does it stamp a provenance this resolver can read?
    const deployed = await D.createVehicleActorFromItem(packItem, { name: "__PWF__Deployed" });
    out.made.push(deployed.id);
    ok("C deploy stamps a resolvable compendium provenance",
      F.isCatalogVehicle(deployed) === true, JSON.stringify(F.vehiclePackSource(deployed)));
    const dr = await open(deployed);
    ok("C a compendium-deployed vehicle shows NO picker", !sel(dr) && !strip(dr));
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
    ok("C catalog tank: no picker", !sel(r));
    ok("C catalog tank derives the MM combat face", !!r.querySelector('input[name="system.sp.side"]'));
    ok("C catalog tank does NOT write a designation (stored pair untouched)",
      viaOwned.system.isMMVehicle === false && viaOwned.system.isACPA === false,
      `${viaOwned.system.isACPA}/${viaOwned.system.isMMVehicle}`);

    // NEGATIVE: same provenance, a class that derives nothing special -> the standard face.
    const viaOwnedCar = await mk("__PWF__ViaOwnedCar", { vehicleType: "car", vehicleTypeText: "Sedan", sp: { front: 10 } },
      { [SCOPE]: { sourceItemUuid: owned.uuid, createdBy: game.user.id } });
    let rc = await open(viaOwnedCar);
    ok("C catalog car derives the standard face, still no picker",
      !!rc.querySelector('input[name="system.speedValue"]') && !sel(rc));

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
      !!psr.querySelector('input[name="system.sp.side"]') && !sel(psr));
    await packStored.sheet.close();

    // NEGATIVE: a source item with no compendium origin at all = a custom vehicle, picker shown.
    const loose = await Item.create({ name: "__PWF__LooseItem", type: "vehicle" });
    out.items.push(loose.id);
    const viaLoose = await mk("__PWF__ViaLoose", { vehicleType: "tank", vehicleTypeText: "Tank" },
      { [SCOPE]: { sourceItemUuid: loose.uuid, createdBy: game.user.id } });
    ok("C NEGATIVE: a non-compendium source item is not catalog provenance",
      F.isCatalogVehicle(viaLoose) === false);
    const vlr = await open(viaLoose);
    ok("C NEGATIVE: that vehicle keeps its picker, and its undesignated face is Standard",
      !!sel(vlr) && sel(vlr).value === "standard", sel(vlr)?.value);
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

await page.evaluate(async ({ made, items }) => {
  for (const id of made) { const a = game.actors.get(id); await a?.sheet?.close(); await a?.delete().catch(() => {}); }
  for (const id of items) await game.items.get(id)?.delete().catch(() => {});
  const f = game.folders.find(x => x.type === "Actor" && x.name === "Vehicles");
  if (f && f.contents.length === 0) await f.delete().catch(() => {});
}, res);

check("0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
