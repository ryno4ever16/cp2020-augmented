/**
 * Numeric-field submit guard on the character/NPC actor sheet.
 *
 * DEFECT: `input[type=number]` does not keep text out of the box on every browser. Firefox accepts
 * arbitrary characters into a number field; the element then reports `validity.badInput === true`
 * while its `.value` reads back as the EMPTY STRING. Foundry's FormDataExtended reads `.value` only
 * and maps `""` to `null`, so a box holding a letter submits exactly what a deliberately-cleared box
 * submits. Measured on this rig before the guard existed, the structural-points box
 * (`system.sdp.current.<zone>`) went from a stored 20 to a stored 0 — the sheet's own change handler
 * runs `Number(target.value || 0)` — and the stopping-power box (plain form path) went to `null`.
 *
 * CONTRACT: a numeric field the browser cannot read is EXCLUDED from the update (the stored value
 * survives), the box is repainted from the document, and one notification names the field. A blank
 * box is NOT unreadable: it keeps exactly the meaning it had before the guard (0 on the structural
 * box via the sheet's handler, `null` on the plain form path) — §3 pins both measured values.
 *
 * Run from the module's tests/:
 *   FVTT_URL=http://localhost:30007 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-sheet-number-guard.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30007";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SDP = 'input[name="system.sdp.current.rArm"]';
// The plain-form-path control: an editable, name-bound number box with NO change handler of its own,
// so it exercises the framework submit alone. (The armour stopping-power boxes look like the obvious
// choice but are rendered `readonly` outside edit mode, so nothing can be typed into them at all.)
const STAT = 'input[name="system.stats.ref.base"]';

const checks = [];
const ok = (name, cond, got) => checks.push({ name, pass: !!cond, got });

async function joinAs(page, match, passwords) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 60_000 });
  const users = await sel.locator("option").evaluateAll((o) => o.map((x) => ({ v: x.value, l: (x.textContent || "").trim() })).filter((x) => x.v));
  const u = users.find((x) => match.test(x.l));
  if (!u) throw new Error("no matching user on the join form");
  for (const pw of passwords) {
    await sel.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([
      page.waitForNavigation({ url: /\/game/, timeout: 20_000 }).catch(() => {}),
      page.locator('button[name="join"]').click(),
    ]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 30_000 }); return; } catch {}
  }
  throw new Error("could not join");
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e?.message || e)));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
  await joinAs(page, /^gamemaster$/i, [GM_PW]);

  /* ---------------------------------------------------------------- helpers */

  // Record every warning the module raises, so a leg can assert one fired (and that its text
  // resolved — a missing key would surface as the bare "CYBERPUNK." prefix).
  await page.evaluate(() => {
    window.__NOTES = [];
    const n = ui.notifications;
    if (!n.__cpGuardTap) {
      const orig = n.warn.bind(n);
      n.warn = (msg, opts) => { window.__NOTES.push(String(msg)); return orig(msg, opts); };
      n.__cpGuardTap = true;
    }
  });

  /** Build an actor of `type` carrying a right cyberarm, so the structural-points box renders. */
  const makeActor = (type, key) => page.evaluate(async ([type, key]) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const a = await Actor.create({ name: `__PW__NumGuard-${key}`, type });
    await a.createEmbeddedDocuments("Item", [{
      name: "__PW__RCyberarm", type: "cyberware",
      system: {
        equipped: true, EffectMode: "Permanent", cyberwareType: "CyberArm", MountZone: "Arm",
        CyberBodyType: { Type: "", Location: "Right" },
        CyberWorkType: { Type: "Implant", Types: ["Implant"], SDP: 30 },
      },
    }]);
    for (let i = 0; i < 30 && (Number(a.system?.sdp?.sum?.rArm) || 0) !== 30; i++) await sleep(200);
    await a.sheet.render(true);
    await sleep(2200);
    a.sheet.element.querySelector('.sheet-tabs a[data-tab="combat"]')?.click();
    await sleep(600);
    window.__ACT = window.__ACT || {};
    window.__ACT[key] = a;
    return {
      appId: a.sheet.element.id,
      sumRArm: Number(a.system?.sdp?.sum?.rArm) || 0,
      sdpBox: !!a.sheet.element.querySelector('input[name="system.sdp.current.rArm"]'),
      statBox: !!a.sheet.element.querySelector('input[name="system.stats.ref.base"]'),
      numberBoxes: a.sheet.element.querySelectorAll('input[type="number"][name]').length,
    };
  }, [type, key]);

  /** Put the fixture back to a known pool and clear the recorded warnings. */
  const reset = (key) => page.evaluate(async ([key]) => {
    const a = window.__ACT[key];
    await a.update({ "system.sdp.current": { Head: 0, Torso: 0, lArm: 0, rArm: 20, lLeg: 0, rLeg: 0 } });
    await a.update({ "system.stats.ref.base": 8 });
    await new Promise(r => setTimeout(r, 700));
    window.__NOTES.length = 0;
    return { sdp: Number(a.system?.sdp?.current?.rArm), stat: foundry.utils.getProperty(a._source, "system.stats.ref.base") };
  }, [key]);

  const state = (key) => page.evaluate(([key, sdpSel, statSel]) => {
    const a = window.__ACT[key];
    const root = a.sheet.element;
    const sdpEl = root.querySelector(sdpSel);
    const statEl = root.querySelector(statSel);
    return {
      storedSdp: foundry.utils.getProperty(a._source, "system.sdp.current.rArm"),
      storedSdpAll: foundry.utils.getProperty(a._source, "system.sdp.current"),
      derivedSdp: a.system?.sdp?.current?.rArm,
      storedStat: foundry.utils.getProperty(a._source, "system.stats.ref.base"),
      storedStatsAll: foundry.utils.getProperty(a._source, "system.stats"),
      sdpDom: sdpEl ? sdpEl.value : "(gone)",
      sdpBad: sdpEl ? sdpEl.validity.badInput : null,
      statDom: statEl ? statEl.value : "(gone)",
      statBad: statEl ? statEl.validity.badInput : null,
      notes: [...window.__NOTES],
    };
  }, [key, SDP, STAT]);

  // Sheet element ids, so every gesture is scoped to ONE sheet: two of these windows are open at
  // once by the end of the run and an unscoped selector picks whichever was rendered first.
  const appIds = {};

  /** Type a string into a box for real, then commit it with a change event. */
  const typeAndCommit = async (key, sel, text) => {
    await page.evaluate(([key]) => window.__ACT[key].sheet.bringToFront?.(), [key]);
    const box = page.locator(`#${appIds[key]} ${sel}`).first();
    await box.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    if (text) await page.keyboard.type(text, { delay: 30 });
    const typed = await page.evaluate(([key, sel]) => {
      const el = window.__ACT[key].sheet.element.querySelector(sel);
      return { value: el.value, badInput: el.validity.badInput };
    }, [key, sel]);
    await page.evaluate(([key, sel]) => {
      window.__ACT[key].sheet.element.querySelector(sel).dispatchEvent(new Event("change", { bubbles: true }));
    }, [key, sel]);
    await page.waitForTimeout(1400);
    return typed;
  };

  /* ------------------------------------------------- §0 fixture + predicate */

  const setup = await makeActor("character", "pc");
  appIds.pc = setup.appId;
  ok("fixture: structural pool seeded and both numeric boxes render", setup.sumRArm === 30 && setup.sdpBox && setup.statBox, setup);
  ok("fixture: the sheet form carries a population of numeric boxes to guard", setup.numberBoxes >= 20, setup.numberBoxes);

  const pred = await page.evaluate(async () => {
    const { isUnreadableNumberField } = await import("/modules/cp2020-augmented/module/form-number-guard.js");
    const make = (attrs, value) => {
      const el = document.createElement("input");
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "dtype") el.dataset.dtype = v; else el.setAttribute(k, v);
      }
      document.body.appendChild(el);
      el.value = value;
      const r = isUnreadableNumberField(el);
      el.remove();
      return r;
    };
    return {
      blank: make({ type: "number", name: "a" }, ""),
      good: make({ type: "number", name: "a" }, "12"),
      negative: make({ type: "number", name: "a" }, "-3"),
      unnamed: make({ type: "text", dtype: "Number" }, "a"),
      readonly: make({ type: "text", name: "a", readonly: "readonly", dtype: "Number" }, "a"),
      disabled: make({ type: "text", name: "a", disabled: "disabled", dtype: "Number" }, "a"),
      plainText: make({ type: "text", name: "a" }, "Johnny Silverhand"),
      textNumeric: make({ type: "text", name: "a", dtype: "Number" }, "a"),
      textNumericSpaces: make({ type: "text", name: "a", dtype: "Number" }, "   "),
    };
  }).catch((e) => ({ importError: String(e?.message || e).slice(0, 160) }));
  ok("predicate: a blank box is readable (blank keeps its own meaning)", pred.blank === false, pred.blank ?? pred.importError);
  ok("predicate: a plain number is readable", pred.good === false, pred.good);
  ok("predicate: a negative number is readable", pred.negative === false, pred.negative);
  ok("predicate: an unnamed box is skipped (never submitted)", pred.unnamed === false, pred.unnamed);
  ok("predicate: a read-only box is skipped", pred.readonly === false, pred.readonly);
  ok("predicate: a disabled box is skipped", pred.disabled === false, pred.disabled);
  ok("predicate: a non-numeric text box is skipped", pred.plainText === false, pred.plainText);
  ok("predicate: a numeric-declared text box holding a letter is unreadable", pred.textNumeric === true, pred.textNumeric);
  ok("predicate: whitespace only counts as blank, not unreadable", pred.textNumericSpaces === false, pred.textNumericSpaces);

  /* ------------------------------------------ §1 the reported defect, by value */

  // Chromium refuses to put a bare letter in a type=number box, but it DOES report
  // validity.badInput for a partially-numeric string — "1e" leaves the element in exactly the state
  // Firefox reaches with "a": badInput true, .value "". That is the state the guard reads, so this
  // leg drives the real defect and not an approximation of it.
  let before = await reset("pc");
  ok("§1 pool starts at the seeded value", before.sdp === 20, before);
  let typed = await typeAndCommit("pc", SDP, "1e");
  ok("§1 the typed box really is in the unreadable state (badInput, empty value)", typed.badInput === true && typed.value === "", typed);
  let after = await state("pc");
  ok("§1 the stored structural value SURVIVES the unreadable entry", after.storedSdp === 20, after.storedSdp);
  ok("§1 no sibling zone was rewritten", JSON.stringify(after.storedSdpAll) === JSON.stringify({ Head: 0, Torso: 0, lArm: 0, rArm: 20, lLeg: 0, rLeg: 0 }), after.storedSdpAll);
  ok("§1 the box is repainted from the document and is readable again", after.sdpDom === "20" && after.sdpBad === false, { dom: after.sdpDom, bad: after.sdpBad });
  ok("§1 exactly one warning was raised", after.notes.length === 1, after.notes);
  ok("§1 the warning text resolved (no raw key leaked)", after.notes[0] && !after.notes[0].includes("CYBERPUNK."), after.notes[0]);
  ok("§1 the warning names the field", after.notes[0] && /SDP|sdp/.test(after.notes[0]), after.notes[0]);

  // Second act: the same gesture again, on a box the guard has already repainted once.
  typed = await typeAndCommit("pc", SDP, "-");
  ok("§1b a second unreadable entry is also in the unreadable state", typed.badInput === true, typed);
  after = await state("pc");
  ok("§1b the stored value still survives the second entry", after.storedSdp === 20, after.storedSdp);
  ok("§1b a second warning was raised (one per refusal, not one per session)", after.notes.length === 2, after.notes.length);

  /* -------------------------------------- §2 control: a real edit still writes */

  before = await reset("pc");
  typed = await typeAndCommit("pc", SDP, "12");
  ok("§2 a legitimate entry is readable", typed.badInput === false && typed.value === "12", typed);
  after = await state("pc");
  ok("§2 a legitimate numeric edit still writes", after.storedSdp === 12, after.storedSdp);
  ok("§2 a clean submit raises no warning", after.notes.length === 0, after.notes);

  before = await reset("pc");
  typed = await typeAndCommit("pc", STAT, "9");
  after = await state("pc");
  ok("§2 a legitimate edit on the plain form path still writes", after.storedStat === 9, after.storedStat);
  ok("§2 the plain-path clean submit raises no warning", after.notes.length === 0, after.notes);

  /* ------------------------ §3 blank keeps the meaning it had before the guard */

  // Both values below were MEASURED on this rig against the pre-guard build. They are pinned so the
  // guard cannot quietly change what an intentionally-emptied box does.
  before = await reset("pc");
  typed = await typeAndCommit("pc", SDP, "");
  ok("§3 the emptied structural box is blank, not unreadable", typed.value === "" && typed.badInput === false, typed);
  after = await state("pc");
  ok("§3 blank on the structural box still resolves to 0, as before the guard", after.storedSdp === 0, after.storedSdp);
  ok("§3 blanking raises no warning", after.notes.length === 0, after.notes);

  before = await reset("pc");
  typed = await typeAndCommit("pc", STAT, "");
  ok("§3 the emptied plain-path box is blank, not unreadable", typed.value === "" && typed.badInput === false, typed);
  after = await state("pc");
  ok("§3 blank on the plain form path still resolves to null, as before the guard", after.storedStat === null, after.storedStat);
  ok("§3 blanking the plain-path box raises no warning", after.notes.length === 0, after.notes);

  /* ------------------------ §4 the plain form path also survives an unreadable box */

  before = await reset("pc");
  typed = await typeAndCommit("pc", STAT, "1e");
  ok("§4 the plain-path box reaches the unreadable state", typed.badInput === true && typed.value === "", typed);
  after = await state("pc");
  ok("§4 the stored value SURVIVES (this box has no change handler of its own)", after.storedStat === 8, after.storedStat);
  ok("§4 the plain-path box is repainted from the document", after.statDom === "8" && after.statBad === false, { dom: after.statDom, bad: after.statBad });
  ok("§4 one warning was raised for it", after.notes.length === 1, after.notes);
  // The refused box shares one object-valued field with eight siblings, and a submit carries the WHOLE
  // object — so the refusal has to put the stored number BACK, not drop it. Dropping it reset this box
  // to the schema default (5) while every sibling kept its value: the shape this leg exists to catch.
  ok("§4 no sibling in the same object-valued field was disturbed",
    after.storedStatsAll && Object.entries(after.storedStatsAll).every(([k, v]) => v?.base === (k === "ref" ? 8 : 5) && v?.tempMod === 0),
    after.storedStatsAll);

  /* ------------------- §5 the value/finite signal, for hosts without badInput */

  // Chromium will not hold a letter in a type=number box, so this leg reaches the SECOND signal the
  // guard reads — a non-empty value that is not a finite number — the way a host that does not
  // report badInput would present it. The fixture switches the live box to type=text and marks it
  // data-dtype="Number" (the base system's own declaration for a numeric field in a non-number box);
  // nothing else about the submit path is altered.
  before = await reset("pc");
  const finite = await page.evaluate(async ([key, sel]) => {
    const el = window.__ACT[key].sheet.element.querySelector(sel);
    el.type = "text";
    el.dataset.dtype = "Number";
    el.value = "a";
    const seen = { value: el.value, badInput: el.validity.badInput };
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return seen;
  }, ["pc", SDP]);
  await page.waitForTimeout(1400);
  ok("§5 the emulated box carries a raw non-numeric value and NO badInput signal", finite.value === "a" && finite.badInput === false, finite);
  after = await state("pc");
  ok("§5 the stored value survives on the value/finite signal alone", after.storedSdp === 20, after.storedSdp);
  ok("§5 that refusal warned too", after.notes.length === 1, after.notes);

  /* ------------------------------------------- §6 the same sheet class, NPC actor */

  const npcSetup = await makeActor("npc", "npc");
  appIds.npc = npcSetup.appId;
  await page.evaluate(() => window.__ACT.pc.sheet.close());
  await page.waitForTimeout(600);
  ok("§6 NPC fixture renders the structural box on the same sheet class", npcSetup.sumRArm === 30 && npcSetup.sdpBox, npcSetup);
  before = await reset("npc");
  typed = await typeAndCommit("npc", SDP, "1e");
  ok("§6 the NPC box reaches the unreadable state", typed.badInput === true, typed);
  after = await state("npc");
  ok("§6 the NPC's stored structural value survives", after.storedSdp === 20, after.storedSdp);
  ok("§6 the NPC refusal warned", after.notes.length === 1, after.notes);

  /* ------------------------------------------------------------------ §7 noise */

  const relevant = pageErrors.filter(t => !/favicon|Failed to load resource/i.test(t));
  ok("§7 0 console errors", relevant.length === 0, relevant.slice(0, 4));

  await page.evaluate(async () => {
    for (const a of game.actors.filter(a => a.name.startsWith("__PW__NumGuard"))) await a.delete().catch(() => {});
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
