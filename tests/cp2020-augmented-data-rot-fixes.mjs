/**
 * Pack data-rot fixes (:30004, official 1.1.1 + module) — Batch 1 + Batch 2 of
 * import-staging/PACK-DATA-ROT-SWEEP.md.
 *
 * Three mechanisms are covered:
 *  1. module/lookups.js CALIBER_ALIASES — spelling variants ("9 mm", ".30-06", "arrows", …) resolve
 *     onto the registry id, so the reload match and the ammo box price both work for those items.
 *  2. module/data-corrections.js per-item ENTRIES — the " AP"-suffixed damage strings become a
 *     parseable formula plus the `ap` boolean, and the free-text concealability values become the
 *     enum value.
 *  3. module/data-corrections.js pack RULE (applyPackRulesToItemSystem) — placeholder availability
 *     and the non-canonical reliability spelling are normalized for two named packs only.
 *
 * Every leg reads the REAL chain: pack documents are imported through Item.create so the
 * preCreateItem correction hook actually fires. Negative legs prove the rule does not reach outside
 * its two packs and that the pre-existing Tech-Assault entry is unchanged.
 *
 * Run from fork tests/:
 *   FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-data-rot-fixes.mjs
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

async function joinAs(page, match, passwords) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 30_000 });
  const users = await sel.locator("option").evaluateAll((o) =>
    o.map((x) => ({ v: x.value, l: (x.textContent || "").trim() })).filter((x) => x.v));
  const u = users.find((x) => match.test(x.l));
  if (!u) throw new Error("no user matching " + match);
  for (const pw of passwords) {
    await sel.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([
      page.waitForNavigation({ url: /\/game/, timeout: 15_000 }).catch(() => {}),
      page.locator('button[name="join"]').click(),
    ]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 20_000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await sel.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join as " + u.l);
}

const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  // Foundry logs a console error below 1366x768 — give the context a real desktop viewport so the
  // 0-console-errors leg reports the module's errors, not the harness window size.
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await joinAs(page, /^gamemaster$/i, [GM_PW]);

  const R = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const PISTOLS_ADD = "cyberpunk2020.pistols-add";
    const RIFLES_ADD  = "cyberpunk2020.rifles-add";
    const SMGS_ADD    = "cyberpunk2020.smgs-add";
    const PISTOLS     = "cyberpunk2020.pistols";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const created = [];

    try {
      const L = await import(`${M}/lookups.js`);
      const C = await import(`${M}/data-corrections.js`);

      /* ── 1. caliber alias registry ─────────────────────────────────────────────────────────── */
      ok('alias: "9 mm" resolves to the 9mm registry id',
        L.caliberMatches("9 mm", "9mm") === true, L.caliberMatches("9 mm", "9mm"));
      ok('alias: ".30-06" (leading dot variant) resolves to 30-06',
        L.caliberMatches(".30-06", "30-06") === true, L.caliberMatches(".30-06", "30-06"));
      ok('alias: "arrows" (pluralized projectile name) resolves to Arrow',
        L.caliberMatches("arrows", "Arrow") === true, L.caliberMatches("arrows", "Arrow"));
      ok('alias: "10 mm S" (suffixed variant) resolves to 10mm',
        L.caliberMatches("10 mm S", "10mm") === true, L.caliberMatches("10 mm S", "10mm"));
      ok('alias regression: pre-existing "7.56" still resolves to 7.62',
        L.caliberMatches("7.56", "7.62") === true, L.caliberMatches("7.56", "7.62"));
      ok('alias NEGATIVE: "9 mm" still does not match a different bore (12mm)',
        L.caliberMatches("9 mm", "12mm") === false, L.caliberMatches("9 mm", "12mm"));
      const box9 = L.getCaliberBox(L.normalizeCaliber("9 mm"));
      ok('alias: box lookup for "9 mm" now prices as the 9mm cost class (box 50, price 15)',
        box9.box === 50 && box9.price === 15, JSON.stringify(box9));
      const boxRaw = L.getCaliberBox("9 mm");
      ok('alias context: the RAW spelling still needs normalizeCaliber (unresolved → box 1 / 0eb)',
        boxRaw.box === 1 && boxRaw.price === 0, JSON.stringify(boxRaw));

      /* ── 1b. designation-suffix alias tier (CALIBER-REGISTRY-PROPOSAL.md §7a, 61 spellings) ────
       * One spot-check per FAMILY of suffix rather than all 61 — the mechanism is the same lookup
       * for every spelling in a family, so a family representative is what can regress. */
      // origin suffix: NATO vs Soviet must resolve to the registry's two DIFFERENT entries.
      ok('suffix family "origin": "7.62N" resolves to the NATO entry',
        L.normalizeCaliber("7.62N") === "7.62", L.normalizeCaliber("7.62N"));
      ok('suffix family "origin": "7.62x54R" resolves to the Soviet entry, not the NATO one',
        L.normalizeCaliber("7.62x54R") === "7.62sov", L.normalizeCaliber("7.62x54R"));
      ok('suffix family "origin" NEGATIVE: the NATO/Soviet split survives aliasing',
        L.caliberMatches("7.62N", "7.62sov") === false, L.caliberMatches("7.62N", "7.62sov"));
      // case type: caseless / long caseless / cased all name the same bore.
      ok('suffix family "case type": "9 mm C" resolves to 9mm',
        L.normalizeCaliber("9 mm C") === "9mm", L.normalizeCaliber("9 mm C"));
      ok('suffix family "case type": "12mm Long Caseless" resolves to 12mm',
        L.normalizeCaliber("12mm Long Caseless") === "12mm", L.normalizeCaliber("12mm Long Caseless"));
      // propellant / projectile designation: ramjet, EHI, rocket, gyrojet all ride the same bore.
      ok('suffix family "propellant": "10mm ramjet" resolves to 10mm',
        L.normalizeCaliber("10mm ramjet") === "10mm", L.normalizeCaliber("10mm ramjet"));
      ok('suffix family "propellant": "20mm EHI cased" resolves to 20mm',
        L.normalizeCaliber("20mm EHI cased") === "20mm", L.normalizeCaliber("20mm EHI cased"));
      // load name: Magnum / ACP name a load, not a bore.
      ok('suffix family "load name": ".44M" resolves to .44',
        L.normalizeCaliber(".44M") === ".44", L.normalizeCaliber(".44M"));
      ok('suffix family "load name": ".45 ACP" resolves to .45',
        L.normalizeCaliber(".45 ACP") === ".45", L.normalizeCaliber(".45 ACP"));
      // gauge labels: the payoff is the FAMILY, not just the price — a gauge-labelled weapon was
      // being offered the firearm load list instead of the shotgun one.
      ok('suffix family "gauge": "CAL12" resolves to the shotgun registry entry',
        L.normalizeCaliber("CAL12") === "00", L.normalizeCaliber("CAL12"));
      ok('suffix family "gauge": a gauge-labelled weapon now reads as the shotgun family',
        L.caliberFamily("CAL12") === "shotgun", L.caliberFamily("CAL12"));
      ok('suffix family "gauge": the shotgun-only load is now offered to it',
        L.modifiersForCaliber("CAL12").some(([id]) => id === "stundart"),
        JSON.stringify(L.modifiersForCaliber("CAL12").map(([id]) => id)));
      const box12ga = L.getCaliberBox(L.normalizeCaliber("12ga"));
      ok('suffix family "gauge": box lookup prices as the shotgun cost class (box 12, price 15)',
        box12ga.box === 12 && box12ga.price === 15, JSON.stringify(box12ga));
      // non-cartridge projectile names that already have a registry entry.
      ok('projectile name: "quarrels" resolves to the crossbow-bolt entry',
        L.normalizeCaliber("quarrels") === "Bolt", L.normalizeCaliber("quarrels"));
      ok('projectile name: those crossbows now read as the arrow family, not firearm',
        L.caliberFamily("quarrels") === "arrow", L.caliberFamily("quarrels"));
      ok('projectile name: an arrow-only load is offered and a firearm-only load is not',
        L.modifiersForCaliber("quarrels").some(([id]) => id === "broadhead") &&
        !L.modifiersForCaliber("quarrels").some(([id]) => id === "hollowPoint"),
        JSON.stringify(L.modifiersForCaliber("quarrels").map(([id]) => id)));
      ok('projectile name: "fuel (4 shots)" resolves to the flamethrower-fuel entry',
        L.normalizeCaliber("fuel (4 shots)") === "Napalm", L.normalizeCaliber("fuel (4 shots)"));
      // NEGATIVES — the tier is exactly the ratified 61; nothing outside it was aliased.
      ok('alias scope NEGATIVE: a bore with no registry entry (".40 S&W") is still unresolved',
        L.getCaliberBox(L.normalizeCaliber(".40 S&W")).price === 0, L.normalizeCaliber(".40 S&W"));
      ok('alias scope NEGATIVE: a gauge spelling outside the ratified tier ("CAL12 MAG") is still unresolved',
        L.caliberFamily("CAL12 MAG") === "firearm" && L.getCaliberBox(L.normalizeCaliber("CAL12 MAG")).price === 0,
        L.normalizeCaliber("CAL12 MAG"));
      ok('alias NEGATIVE: a gauge alias does not make shotgun ammo loadable into a rifle bore',
        L.caliberMatches("7.62N", "CAL12") === false, L.caliberMatches("7.62N", "CAL12"));

      /* ── 2. real imports through the preCreateItem chain ───────────────────────────────────── */
      const mkFrom = async (packId, id) => {
        const doc = await game.packs.get(packId).getDocument(id);
        const it = await Item.create(game.items.fromCompendium(doc));
        created.push(it);
        return it;
      };
      const rawOf = async (packId, id) => (await game.packs.get(packId).getDocument(id)).system;

      // 2a. placeholder availability → clean blank, with the shared stamp present.
      const rawGnome = await rawOf(PISTOLS_ADD, "0plHCzWiYgjpWuZj");
      ok('rule precondition: the pack document really stores the literal string "undefined"',
        rawGnome.availability === "undefined", JSON.stringify(rawGnome.availability));
      const gnome = await mkFrom(PISTOLS_ADD, "0plHCzWiYgjpWuZj");
      ok("rule: imported copy carries a blank availability, not the literal placeholder",
        gnome.system.availability === "", JSON.stringify(gnome.system.availability));
      ok("rule: imported copy carries the shared correction stamp",
        gnome.getFlag("cp2020-augmented", "correctionApplied") === true,
        gnome.getFlag("cp2020-augmented", "correctionApplied"));

      // 2b. reliability spelling → the enum value the threshold lookup matches.
      const rawFerro = await rawOf(PISTOLS_ADD, "yXpTaNDwOdjkCC8d");
      ok('rule precondition: the pack document stores the spaced spelling "very reliable"',
        rawFerro.reliability === "very reliable", JSON.stringify(rawFerro.reliability));
      const ferro = await mkFrom(PISTOLS_ADD, "yXpTaNDwOdjkCC8d");
      ok("rule: imported copy stores the canonical reliability enum value",
        ferro.system.reliability === "VeryReliable", ferro.system.reliability);

      // 2c. …and that value resolves to threshold 3 through the REAL consuming function.
      const U = await import("/systems/cyberpunk2020/module/utils.js");
      const thrRaw = U.reliabilityThreshold(rawFerro.reliability);
      const thrFixed = U.reliabilityThreshold(ferro.system.reliability);
      ok("consuming path: the raw spaced spelling falls through to the default threshold 5",
        thrRaw === 5, thrRaw);
      ok("consuming path: the normalized value resolves to threshold 3",
        thrFixed === 3, thrFixed);

      // 2d. " AP"-suffixed damage → parseable formula + the ap boolean.
      ok('entry precondition: the pack document stores the unparseable "3D6 AP"',
        rawFerro.damage === "3D6 AP" && rawFerro.ap === false, `${rawFerro.damage} / ap=${rawFerro.ap}`);
      ok("entry: imported copy carries a formula Roll.validate accepts",
        ferro.system.damage === "3D6" && Roll.validate(ferro.system.damage) === true,
        `${ferro.system.damage} / valid=${Roll.validate(ferro.system.damage)}`);
      ok("entry: the suffix moved to the ap boolean the SP math reads",
        ferro.system.ap === true, ferro.system.ap);
      const groza = await mkFrom(RIFLES_ADD, "EqupdgO5LXciazY8");
      ok("entry: second pack's AP item also parses and carries ap=true",
        groza.system.damage === "4D6" && Roll.validate(groza.system.damage) === true && groza.system.ap === true,
        `${groza.system.damage} / ap=${groza.system.ap}`);
      const armalite = await mkFrom(PISTOLS_ADD, "jHCXRRomdgY4mdgY");
      ok("entry: the formula with a flat term survives intact (3D6+1)",
        armalite.system.damage === "3D6+1" && Roll.validate(armalite.system.damage) === true && armalite.system.ap === true,
        `${armalite.system.damage} / ap=${armalite.system.ap}`);

      // 2e. free-text concealability on a base pack → the enum value.
      const rawMpk11 = await rawOf(SMGS_ADD, "tUw3deoRLKzUbQEI");
      ok('entry precondition: the pack document stores the free-text "long coat"',
        rawMpk11.concealability === "long coat", JSON.stringify(rawMpk11.concealability));
      const mpk11 = await mkFrom(SMGS_ADD, "tUw3deoRLKzUbQEI");
      ok("entry: imported copy carries the concealability enum value",
        mpk11.system.concealability === "ConcealLongcoat", mpk11.system.concealability);
      const mpk9 = await mkFrom(SMGS_ADD, "VCNhTdWnVoPTYYzi");
      ok('entry: the second free-text spelling ("jacket") also maps onto the enum',
        mpk9.system.concealability === "ConcealJacket", mpk9.system.concealability);
      ok("scope: the rule does NOT reach this pack — its availability is left as authored",
        mpk9.system.availability === "common", JSON.stringify(mpk9.system.availability));

      /* ── 3. NEGATIVES ──────────────────────────────────────────────────────────────────────── */
      // 3a. a clean core-pack item imports byte-identical — no rule bleed outside the two packs.
      const CLEAN_ID = (await game.packs.get(PISTOLS).getIndex()).contents
        .map(e => e._id).find(id => !C.correctionFor(PISTOLS, id));
      const rawClean = await rawOf(PISTOLS, CLEAN_ID);
      const clean = await mkFrom(PISTOLS, CLEAN_ID);
      const drift = Object.keys(rawClean)
        .filter(k => JSON.stringify(rawClean[k]) !== JSON.stringify(clean.system[k]));
      ok("negative: an uncorrected core-pack item imports with every system field unchanged",
        drift.length === 0, `changed fields: ${JSON.stringify(drift)} (${CLEAN_ID})`);
      ok("negative: that item carries NO correction stamp",
        clean.getFlag("cp2020-augmented", "correctionApplied") === undefined,
        clean.getFlag("cp2020-augmented", "correctionApplied"));
      ok("negative: the rule leaves a non-listed pack alone even when called directly",
        C.applyPackRulesToItemSystem(PISTOLS, { availability: "undefined", reliability: "very reliable" }) === false, false);

      // 3b. regression: the pre-existing six-field entry still applies in full and wins over the rule.
      const techA = await mkFrom(RIFLES_ADD, "i5fKapFKJhgx3ia2");
      const t = techA.system;
      const six = {
        weaponType: t.weaponType === "SMG",
        attackSkill: t.attackSkill === "Submachinegun",
        ammoType: t.ammoType === ".22",
        damage: t.damage === "1D6",
        concealability: t.concealability === "ConcealJacket",
        availability: t.availability === "Excellent",
      };
      ok("regression: the pre-existing six-field entry still applies all six fields",
        Object.values(six).every(Boolean), JSON.stringify(six));
      ok("composition: the book-verified entry value wins over the rule's blank availability",
        t.availability === "Excellent", t.availability);

      /* ── 4. sheet select round-trip (the silent-rewrite hazard) ────────────────────────────── */
      const sheetHtml = await (foundry?.applications?.handlebars?.renderTemplate ?? renderTemplate)(
        "modules/cp2020-augmented/templates/item/parts/weapon/settings.hbs",
        {
          system: gnome.system, item: gnome,
          availabilities: Object.values(L.availability),
          concealabilities: Object.values(L.concealability),
          reliabilities: Object.values(L.reliability),
          weaponTypes: Object.values(L.weaponTypes), attackTypes: [], attackSkills: [], ammoChoices: [],
        });
      const doc2 = new DOMParser().parseFromString(sheetHtml, "text/html");
      const availSel = doc2.querySelector('select[name="system.availability"]');
      const availOpts = [...(availSel?.options ?? [])].map(o => o.value);
      const availSelected = [...(availSel?.options ?? [])].filter(o => o.hasAttribute("selected")).map(o => o.value);
      ok("select: the availability control offers a blank option",
        availOpts[0] === "", JSON.stringify(availOpts));
      ok("select: a blank stored value marks the BLANK option selected (a save re-stores the blank)",
        availSelected.length === 1 && availSelected[0] === "", JSON.stringify(availSelected));
      const concSel = doc2.querySelector('select[name="system.concealability"]');
      ok("select: the concealability control also offers a blank option",
        [...(concSel?.options ?? [])].map(o => o.value)[0] === "",
        JSON.stringify([...(concSel?.options ?? [])].map(o => o.value)));
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    } finally {
      for (const it of created) { try { await it.delete(); } catch {} }
      out.leftover = game.items.filter(i => created.some(c => c.id === i.id)).length;
    }
    return out;
  });

  for (const c of R.checks) {
    if (!c.pass) failures++;
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : `   [got: ${c.got}]`}`);
  }
  if (R.error) { failures++; console.log("FAIL  in-page error\n" + R.error); }
  const cleanOk = R.leftover === 0;
  if (!cleanOk) failures++;
  console.log(`${cleanOk ? "PASS" : "FAIL"}  cleanup: no created world items left behind (${R.leftover})`);

  const errOk = errors.length === 0;
  if (!errOk) failures++;
  console.log(`${errOk ? "PASS" : "FAIL"}  0 console errors${errOk ? "" : "\n" + errors.join("\n")}`);
  console.log(`\n${R.checks.length + 2 - failures}/${R.checks.length + 2} checks passed`);
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
