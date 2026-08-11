/**
 * Countermeasures loadout UI (:30004, official 1.1.1 + module).
 *
 * The incoming-missile reader (_bestCountermeasure / countermeasureModifier) has always read
 * system.countermeasures, but nothing populated it — so it was always [] and never fired. Added a
 * presence multi-select (9 MM countermeasures) to the vehicle + ACPA sheets: ticking a box rewrites the
 * WHOLE system.countermeasures array (so deselecting all clears it), and the live reader consumes it.
 *
 * Source-shape: the CM set is exported once (vehicle-missiles.js) and shared by the sheet; the partial is
 * registered and included in both sheets; the sheet builds countermeasureOptions + wires the handler.
 * Behavioural: the sheet renders 9 checkboxes, ticking writes the array, unticking all clears it, and
 * countermeasureModifier reads the same field the UI writes.
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-countermeasures-ui.mjs
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
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 15_000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await sel.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join as " + u.l);
}

const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await joinAs(page, /^gamemaster$/i, [GM_PW]);

  const R = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const SCOPE = "cp2020-augmented";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await new Promise(r => setTimeout(r, 50)); } return false; };
    let actor = null, prevMM;
    try {
      // ---- source-shape ----
      const MIS = await import(`${M}/vehicle/vehicle-missiles.js`);
      ok("vehicle-missiles exports COUNTERMEASURES (9)", Array.isArray(MIS.COUNTERMEASURES) && MIS.COUNTERMEASURES.length === 9, MIS.COUNTERMEASURES?.length);
      const ssrc = await (await fetch(`${M}/actor/vehicle-sheet.js`, { cache: "no-store" })).text();
      ok("sheet builds countermeasureOptions + wires handler", /countermeasureOptions/.test(ssrc) && /_cpActivateCountermeasures/.test(ssrc) && /system\.countermeasures/.test(ssrc), true);
      const part = await (await fetch(`/modules/cp2020-augmented/templates/actor/parts/countermeasures.hbs`, { cache: "no-store" })).text();
      ok("partial has cp-cm-box checkboxes with data-cm", /class="cp-cm-box"/.test(part) && /data-cm="\{\{this\.key\}\}"/.test(part), true);
      const vt = await (await fetch(`/modules/cp2020-augmented/templates/actor/vehicle-sheet.hbs`, { cache: "no-store" })).text();
      const at = await (await fetch(`/modules/cp2020-augmented/templates/actor/acpa-sheet.hbs`, { cache: "no-store" })).text();
      ok("both sheets include the countermeasures partial", /parts\/countermeasures\.hbs/.test(vt) && /parts\/countermeasures\.hbs/.test(at), true);
      const enj = await (await fetch(`/modules/cp2020-augmented/lang/en.json`, { cache: "no-store" })).json();
      const need = ["CountermeasuresHeader","CMDefeats","CM_chaff","CM_stealth","CM_antiLaserAerosol"];
      ok("CM i18n keys present", need.every(k => k in (enj.CYBERPUNK?.Vehicle ?? {})), true);

      // ---- behavioural ----
      prevMM = game.settings.get(SCOPE, "mmEnabled");
      await game.settings.set(SCOPE, "mmEnabled", true);
      for (const x of game.actors.filter(x => x.name === "RIG CM Tank")) await x.delete().catch(() => {});   // pre-sweep prior run
      actor = await Actor.create({ name: "RIG CM Tank", type: "cp2020-augmented.vehicle" });
      await actor.sheet.render(true);
      await waitFor(() => actor.sheet?.element?.querySelector("input.cp-cm-box"));
      const boxes = () => [...(actor.sheet?.element?.querySelectorAll("input.cp-cm-box") ?? [])];
      ok("sheet renders 9 countermeasure checkboxes", boxes().length === 9, boxes().length);
      // layout guard: the loadout reuses the system .field-list/.field grid — a FIXED 2-column grid with the
      // label on the LEFT and the checkbox pushed to the RIGHT of its cell, mirroring the rest of the sheet.
      // Measure at the default width AND widened to 1000px (the sheet is resizable), so neither a
      // width-dependent grid nor a left-hanging checkbox can pass silently.
      const cells = () => boxes().map(b => b.closest(".field")).filter(Boolean);
      const distinctCellLeftX = () => [...new Set(cells().map(c => Math.round(c.getBoundingClientRect().left)))].filter(x => x > 0).length;
      const checkboxOnRightHalf = () => boxes().length > 0 && boxes().every(b => {
        const cell = b.closest(".field"); if (!cell) return false;
        const cr = cell.getBoundingClientRect(), br = b.getBoundingClientRect();
        return (br.left + br.width / 2) > (cr.left + cr.width / 2);   // checkbox center past the cell midpoint
      });
      const probe = async (w) => {
        if (w) { actor.sheet.setPosition({ width: w }); await waitFor(() => Math.round(actor.sheet.element.getBoundingClientRect().width) >= w - 60); await new Promise(r => setTimeout(r, 150)); }
        return { cols: distinctCellLeftX(), boxRight: checkboxOnRightHalf() };
      };
      const startW = actor.sheet.position?.width;
      const pDef = await probe(null);
      ok("2 aligned columns at default width", pDef.cols === 2, pDef.cols);
      ok("checkbox sits on the RIGHT of its label/cell (default width)", pDef.boxRight, pDef.boxRight);
      const pWide = await probe(1000);
      ok("still 2 columns widened to 1000px (fixed .field-list grid, not width-dependent)", pWide.cols === 2, pWide.cols);
      ok("checkbox still on the RIGHT of its cell when widened", pWide.boxRight, pWide.boxRight);
      if (startW) actor.sheet.setPosition({ width: startW });

      const tick = async (cm) => {
        const b = boxes().find(x => x.dataset.cm === cm);
        if (!b) return false;
        b.checked = true; b.dispatchEvent(new Event("change", { bubbles: true }));
        return waitFor(() => (actor.system.countermeasures ?? []).includes(cm));
      };
      const okChaff = await tick("chaff");
      ok("ticking Chaff writes system.countermeasures", okChaff && actor.system.countermeasures.includes("chaff"), JSON.stringify(actor.system.countermeasures));
      const okFlares = await tick("flares");
      ok("ticking Flares appends (array grows, not replaces)", okFlares && actor.system.countermeasures.includes("chaff") && actor.system.countermeasures.includes("flares"), JSON.stringify(actor.system.countermeasures));

      // untick all → clears to []
      for (const b of boxes()) b.checked = false;
      const any = boxes()[0];
      if (any) any.dispatchEvent(new Event("change", { bubbles: true }));
      const cleared = await waitFor(() => (actor.system.countermeasures ?? []).length === 0);
      ok("unticking all clears system.countermeasures to []", cleared, JSON.stringify(actor.system.countermeasures));

      // reader consumes the SAME field the UI writes
      await actor.update({ "system.countermeasures": ["stealth"] });
      ok("reader: stealth defeats radar (+15)", MIS.countermeasureModifier(["stealth"], "radar") === 15, MIS.countermeasureModifier(["stealth"], "radar"));
      ok("reader: chaff does NOT defeat laser (+0)", MIS.countermeasureModifier(["chaff"], "laser") === 0, MIS.countermeasureModifier(["chaff"], "laser"));
    } catch (e) {
      out.error = e?.stack || e?.message || String(e);
    } finally {
      try { await actor?.sheet?.close(); } catch {}
      try { if (actor) await actor.delete(); } catch {}
      try { if (prevMM !== undefined) await game.settings.set(SCOPE, "mmEnabled", prevMM); } catch {}
    }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("Countermeasures loadout UI\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(52)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
