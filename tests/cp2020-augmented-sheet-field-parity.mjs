/**
 * SHEET FIELD PARITY — the vehicle family's field boxes, its face strip, and its paired value rows.
 *
 * WHAT THIS PINS, and why each leg exists (user reports, 2026-08-25/26):
 *
 * ① BORDERS ON EVERY FACE. A vehicle actor has three sheet layouts and they were not styled alike:
 *    the containment rules (a box per field — its own border and padding — with real gutters between
 *    cells) were scoped to the `.cp-vehicle-item-fields` wrapper that only the CIVILIAN face carries,
 *    so the Maximum Metal and ACPA faces rig-measured `0px none` border and `0px` padding while the
 *    civilian face measured 1px and 2px 4px. The user's words were "the Maximum Metal sheet looks
 *    messy by comparison". The base system's own `.cyberpunk .field` border is unset by the dark skin,
 *    so that restore was the only thing putting a line back — which is why the defect is invisible
 *    under the light theme and total under the dark one. These legs therefore read the theme first and
 *    assert the border THAT theme should produce.
 *
 * ② THE FACE STRIP IS BOUNDED, NOT TINTED. The strip that picks a vehicle's sheet was drawn as a
 *    lightened ground with a hairline under it — a device nothing else on these sheets uses, which is
 *    why the user read it as a grey box that "looks strange" and did not belong. It is now bounded the
 *    way every field box beside it is: one line, same token, no ground of its own.
 *
 * ③ PAIRED VALUE BOXES. Two entries either side of a separator (Crew / Pass., Footprint W × H, the
 *    value/max pairs) were flex-stretched to whatever the row had spare — rig-measured 144px each on
 *    SDP for a figure of at most five digits — with the separator jammed against both at 0px. The rule
 *    is: the separator sits the same distance from each box, and each box is only as wide as the
 *    largest figure the field permits, declared on the row as a digit count.
 *
 * ④ THE DERIVED-FACE LINE NAMES THE FACE. "this is the sheet the vehicle's own class calls for" was
 *    read as a statement about the class rather than about which sheet was on screen; it now names it.
 *
 * ⚠ TWO WIDTHS, ALWAYS. The vehicle sheet is resizable and Foundry does not clamp a resize, so one
 * width green is false confidence — every geometric leg is re-run at a narrow width.
 *
 * Run from the module's tests/:
 *   FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=... node cp2020-augmented-sheet-field-parity.mjs
 * Optional: CP_SHOTS=1 writes screenshots beside the suite for the user's by-eye sign-off.
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const VEHICLE = "cp2020-augmented.vehicle";
const SHOTS = process.env.CP_SHOTS === "1";
const SHOT_DIR = process.env.CP_SHOT_DIR || "../captures";

const checks = [];
const ok = (name, cond, got) => checks.push({ name, pass: !!cond, got });

async function joinGM(p) {
  await p.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const s = p.locator('select[name="userid"]');
  await s.waitFor({ state: "visible", timeout: 30000 });
  const us = await s.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  const g = us.find(u => /gamemaster/i.test(u.l)) || us[0];
  await s.selectOption(g.v);
  await p.locator('input[name="password"]').fill(PW);
  await Promise.all([p.waitForNavigation({ url: /\/game/, timeout: 45000 }).catch(() => {}), p.locator('button[name="join"]').click()]);
  await p.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 60000 });
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1100 } })).newPage();
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(String(e?.message || e)));
  page.on("console", m => { if (m.type() === "error") pageErrors.push(m.text()); });
  await joinGM(page);
  if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });

  /* ------------------------------------------------------------------ fixtures */

  const setup = await page.evaluate(async ([VEHICLE]) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__FieldParity"))) await a.delete().catch(() => {});
    for (const i of game.items.filter(i => i.name?.startsWith("__PW__FieldParity"))) await i.delete().catch(() => {});
    window.__FP = { veh: {} };
    // One actor per face, designated through the SAME stored pair the picker writes, so the sheets
    // under test are the ones a user gets rather than a hand-forced render.
    for (const [face, patch] of [["standard", { isACPA: false, isMMVehicle: false }],
                                 ["mm", { isACPA: false, isMMVehicle: true }],
                                 ["acpa", { isACPA: true, isMMVehicle: false }]]) {
      const a = await Actor.create({ name: `__PW__FieldParity-${face}`, type: VEHICLE });
      await a.update({ ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [`system.${k}`, v])),
        "system.crewSlots": 2, "system.passengerSlots": 4,
        "system.layout.hullW": 2, "system.layout.hullH": 4,
        "system.sdp.value": 60, "system.sdp.max": 60, "system.speedValue": 40, "system.topSpeed": 120 });
      await sleep(250);
      window.__FP.veh[face] = a;
    }
    window.__FP.item = await Item.create({ name: "__PW__FieldParity-Slip", type: "vehicle" });
    return {
      theme: document.body.className,
      skin: document.body.classList.contains("cp-carolingian"),
      mmOn: (() => { try { return !!game.settings.get("cp2020-augmented", "mmEnabled"); } catch { return false; } })(),
    };
  }, [VEHICLE]);

  ok("fixtures: the world reports which theme is in force (the border a sheet should draw depends on it)",
    typeof setup.theme === "string" && setup.theme.length > 0, setup.theme);
  ok("fixtures: Maximum Metal is enabled, so the MM face is reachable", setup.mmOn === true, setup.mmOn);

  // The border the dark skin restores, and the base system's own literal under the light one. Both are
  // read from the sheet at run time; only the EXPECTATION is chosen here.
  const wantBorder = setup.skin ? { width: "1px", style: "solid" } : { width: "2px", style: "solid" };

  /**
   * Measure one open sheet: every field box's border/padding, the face strip's ground and border, the
   * derived-face line, and the geometry of each paired value row.
   */
  const measure = (kind, key) => page.evaluate(([kind, key]) => {
    const doc = kind === "item" ? window.__FP.item : window.__FP.veh[key];
    const root = doc?.sheet?.element;
    if (!root) return { rendered: false };
    const cs = el => el ? getComputedStyle(el) : null;
    const rect = el => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, h: r.height }; };

    const fields = [...root.querySelectorAll(".field-list > .field")];
    const fieldStyles = fields.map(f => { const s = cs(f); return { bw: s.borderTopWidth, bs: s.borderTopStyle, bc: s.borderTopColor, pad: s.padding }; });

    const strip = root.querySelector(".cp-veh-face-strip");
    const sStyle = cs(strip);

    const pairs = [...root.querySelectorAll(".cp-paired-values")].map(sp => {
      const ins = [...sp.querySelectorAll(":scope > input[type=number]")];
      const sep = sp.querySelector(":scope > .cp-pair-sep");
      if (ins.length !== 2 || !sep) return null;
      const a = rect(ins[0]), s = rect(sep), b = rect(ins[1]);
      const label = (sp.closest(".field")?.querySelector("label")?.textContent || "").trim();
      return { label, digits: (sp.className.match(/cp-pair-(\d)d/) || [])[1] ?? null,
               leftGap: Math.round((s.l - a.r) * 100) / 100, rightGap: Math.round((b.l - s.r) * 100) / 100,
               w0: Math.round(a.w * 100) / 100, w1: Math.round(b.w * 100) / 100,
               sameRow: Math.abs(a.h - b.h) < 0.5 };
    }).filter(Boolean);

    // Nothing on the sheet may clip its own label.
    const clipped = [...root.querySelectorAll(".field-list > .field > label")]
      .filter(l => l.scrollWidth > l.clientWidth + 1).map(l => l.textContent.trim());

    return {
      rendered: true,
      appId: root.id,
      fieldCount: fields.length,
      fieldStyles,
      strip: strip ? { bg: sStyle.backgroundColor, bw: sStyle.borderTopWidth, bs: sStyle.borderTopStyle, bc: sStyle.borderTopColor } : null,
      derivedHint: root.querySelector(".cp-veh-face-derived")?.textContent?.trim() ?? null,
      selected: root.querySelector(".cp-veh-face-select")?.selectedOptions?.[0]?.textContent?.trim() ?? null,
      pairs, clipped,
      width: root.getBoundingClientRect().width,
    };
  }, [kind, key]);

  const openSheet = (kind, key) => page.evaluate(async ([kind, key]) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (const a of Object.values(window.__FP.veh)) await a.sheet.close().catch(() => {});
    await window.__FP.item.sheet.close().catch(() => {});
    await sleep(350);
    const doc = kind === "item" ? window.__FP.item : window.__FP.veh[key];
    await doc.sheet.render(true);
    await sleep(1400);
    return doc.sheet.element?.id ?? null;
  }, [kind, key]);

  const setWidth = (kind, key, w) => page.evaluate(async ([kind, key, w]) => {
    const doc = kind === "item" ? window.__FP.item : window.__FP.veh[key];
    await doc.sheet.setPosition({ width: w });
    await new Promise(r => setTimeout(r, 700));
    return doc.sheet.element?.getBoundingClientRect().width ?? null;
  }, [kind, key, w]);

  /** The whole assertion battery for one measured sheet, at one width. */
  const assertSheet = (tag, m) => {
    ok(`${tag}: the sheet rendered field boxes`, m.rendered && m.fieldCount > 0, m.fieldCount);
    const wrong = (m.fieldStyles || []).filter(s => s.bw !== wantBorder.width || s.bs !== wantBorder.style);
    ok(`${tag}: EVERY field box carries the sheet family's border (${wantBorder.width} ${wantBorder.style}) — ${m.fieldCount} of ${m.fieldCount}`,
      m.fieldCount > 0 && wrong.length === 0, wrong.slice(0, 3));
    const colours = new Set((m.fieldStyles || []).map(s => s.bc));
    ok(`${tag}: and all of them the SAME colour (one idiom, not two)`, colours.size === 1, [...colours]);
    const pads = new Set((m.fieldStyles || []).map(s => s.pad));
    ok(`${tag}: every field box is padded off its own border (no 0px boxes)`,
      pads.size >= 1 && ![...pads].includes("0px"), [...pads]);
    ok(`${tag}: no field label is clipped`, (m.clipped || []).length === 0, m.clipped);
  };

  const assertStrip = (tag, m) => {
    ok(`${tag}: the face strip is present`, !!m.strip, m.strip);
    ok(`${tag}: the face strip has NO ground of its own (the grey box is gone)`,
      m.strip?.bg === "rgba(0, 0, 0, 0)" || m.strip?.bg === "transparent", m.strip?.bg);
    ok(`${tag}: the face strip is BOUNDED, in the same idiom as the field boxes beside it`,
      m.strip?.bw === "1px" && m.strip?.bs === "solid", { bw: m.strip?.bw, bs: m.strip?.bs, bc: m.strip?.bc });
  };

  const assertPairs = (tag, m, wantLabels) => {
    ok(`${tag}: the paired rows this sheet declares are all present (${wantLabels.length})`,
      (m.pairs || []).length === wantLabels.length, (m.pairs || []).map(p => p.label));
    const off = (m.pairs || []).filter(p => Math.abs(p.leftGap - p.rightGap) > 1);
    ok(`${tag}: the separator sits EQUIDISTANT from both boxes on every paired row`,
      (m.pairs || []).length > 0 && off.length === 0,
      off.map(p => ({ label: p.label, l: p.leftGap, r: p.rightGap })));
    const gapped = (m.pairs || []).filter(p => p.leftGap < 3 || p.rightGap < 3);
    ok(`${tag}: and it is not jammed against them (both gaps are real)`, gapped.length === 0,
      gapped.map(p => ({ label: p.label, l: p.leftGap, r: p.rightGap })));
    const uneven = (m.pairs || []).filter(p => Math.abs(p.w0 - p.w1) > 0.5);
    ok(`${tag}: the two boxes of a pair are the same width`, uneven.length === 0,
      uneven.map(p => ({ label: p.label, w0: p.w0, w1: p.w1 })));
    // Sized for the digits the row declares, not for whatever the row had spare.
    const byDigits = {};
    for (const p of (m.pairs || [])) if (p.digits) (byDigits[p.digits] ??= []).push(p.w0);
    const narrow = byDigits["2"] ? Math.max(...byDigits["2"]) : null;
    const wide = byDigits["5"] ? Math.min(...byDigits["5"]) : null;
    if (narrow !== null && wide !== null) {
      ok(`${tag}: a two-digit pair is NARROWER than a five-digit one (each box sized for what it can hold)`,
        narrow < wide, { twoDigit: narrow, fiveDigit: wide });
    }
    const bloated = (m.pairs || []).filter(p => p.w0 > 90);
    ok(`${tag}: no box is stretched to the row's spare width (the 144px SDP box is gone)`,
      bloated.length === 0, bloated.map(p => ({ label: p.label, w: p.w0 })));
  };

  /* ------------------------------------------- ① + ② + ③ each vehicle face, at two widths */

  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/${name}.png` }); };

  for (const face of ["standard", "mm", "acpa"]) {
    await openSheet("veh", face);
    let m = await measure("veh", face);
    assertSheet(`① ${face} @ default (${Math.round(m.width)}px)`, m);
    assertStrip(`② ${face}`, m);
    await shot(`preship-veh-${face}-default`);

    // ⚠ THE SECOND WIDTH. Foundry does not clamp a resize, and this sheet's cells are a two-column
    // grid — one width green has hidden overlap defects on this exact sheet family before.
    await setWidth("veh", face, 560);
    m = await measure("veh", face);
    assertSheet(`① ${face} @ narrow (${Math.round(m.width)}px)`, m);
    if (face === "standard") assertPairs(`③ ${face} @ narrow`, m, ["Crew / Pass.", "Footprint", "SDP", "Speed"]);
    await shot(`preship-veh-${face}-narrow`);
    await setWidth("veh", face, 800);
  }

  // The civilian face carries every paired shape; measured at the default width too.
  await openSheet("veh", "standard");
  const civ = await measure("veh", "standard");
  assertPairs("③ standard @ default", civ, ["Crew / Pass.", "Footprint", "SDP", "Speed"]);
  // The MM face's own paired row.
  await openSheet("veh", "mm");
  const mm = await measure("veh", "mm");
  assertPairs("③ mm @ default", mm, ["Footprint"]);

  /* ------------------------------------------------------- ④ the derived-face line names the face */

  ok("④ the derived-face line is shown while nothing is designated", typeof civ.derivedHint === "string" && civ.derivedHint.length > 0, civ.derivedHint);
  ok("④ it names the sheet on screen (the {sheet} parameter resolved against the picker's own label)",
    !!civ.selected && !!civ.derivedHint?.includes(civ.selected), { hint: civ.derivedHint, selected: civ.selected });
  ok("④ no raw key and no unfilled placeholder leaked into it",
    !!civ.derivedHint && !civ.derivedHint.includes("CYBERPUNK.") && !civ.derivedHint.includes("{sheet}"), civ.derivedHint);
  ok("④ and it no longer says only that a class 'calls for' a sheet",
    !!civ.derivedHint && !/calls for/i.test(civ.derivedHint), civ.derivedHint);

  /* ------------------------------------------------------------- the vehicle ITEM sheet */

  await openSheet("item", null);
  let it = await measure("item", null);
  assertSheet(`① item slip @ default (${Math.round(it.width)}px)`, it);
  assertStrip("② item slip", it);
  assertPairs("③ item slip @ default", it, ["Crew / Pass.", "SDP", "Speed", "Fuel"]);
  ok("④ the item slip's derived line names its face too",
    !!it.selected && !!it.derivedHint?.includes(it.selected) && !it.derivedHint.includes("{sheet}"),
    { hint: it.derivedHint, selected: it.selected });
  await shot("preship-item-slip-default");
  await setWidth("item", null, 520);
  it = await measure("item", null);
  assertSheet(`① item slip @ narrow (${Math.round(it.width)}px)`, it);
  assertPairs("③ item slip @ narrow", it, ["Crew / Pass.", "SDP", "Speed", "Fuel"]);
  await shot("preship-item-slip-narrow");

  /* --------------------------------------------------------------------------- noise */

  const relevant = pageErrors.filter(t => !/favicon|Failed to load resource/i.test(t));
  ok("0 console errors", relevant.length === 0, relevant.slice(0, 4));

  await page.evaluate(async () => {
    for (const a of Object.values(window.__FP?.veh ?? {})) await a.sheet.close().catch(() => {});
    await window.__FP?.item?.sheet?.close?.().catch(() => {});
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__FieldParity"))) await a.delete().catch(() => {});
    for (const i of game.items.filter(i => i.name?.startsWith("__PW__FieldParity"))) await i.delete().catch(() => {});
  }).catch(() => {});
} finally {
  await browser.close();
}

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed++;
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : `  -> got ${JSON.stringify(c.got)}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
