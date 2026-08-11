/**
 * Group H combat-correctness fixes (:30004, official 1.1.1 + module):
 *  H1 The "Applied N damage to {name}" chat line interpolates the target name (two call sites passed
 *     `target:` instead of the string's `{name}` → literal "{name}" was shown).
 *  H2 executeDeathSave resolves at the SAME mortal level the prompt used (forced by e.g. limb loss),
 *     read from data-mortal-level — it used to re-derive from live wound state, so the roll's threshold
 *     could differ from the one shown. Proof: the resolved threshold now shifts 1:1 with the forced
 *     mortal level (bt − mortal); the old code produced the same threshold regardless.
 *  (H3 = dead-var removal + a console.warn — node-checked, not behaviourally rig-driven.)
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-grouph-combat-correctness.mjs
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
  await page.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});

  const R = await page.evaluate(async () => {
    const M = "/modules/cp2020-augmented/module";
    const out = { checks: [] };
    const ok = (name, cond, got) => out.checks.push({ name, pass: !!cond, got });
    let a = null;
    try {
      // H1 — the DamageApplied string resolves {name} to the target
      const u = await import(`${M}/utils.js`);
      const localizeParam = u.localizeParam;
      const s = localizeParam("DamageApplied", { amount: 7, name: "Rusty" });
      ok("H1 DamageApplied resolves {name}", s.includes("Rusty") && !s.includes("{name}"), s);

      // H2 — resolved death-save threshold shifts 1:1 with the FORCED mortal level
      const SR = await import(`${M}/combat/save-rolls.js`);
      // Pre-clean a prior run's leftover (non-__PW__ name → not caught by a shared sweep).
      for (const x of game.actors.filter(x => x.name === "GRIG DeathSave")) await x.delete().catch(() => {});
      a = await Actor.create({ name: "GRIG DeathSave", type: "character" });
      const bt = Number(a.system?.stats?.bt?.total) || 0;
      const sceneId = window.canvas?.scene?.id ?? "";
      // The card always shows "... vs threshold <b>N</b>" (flavor: "need ≤ N"); parse that, not the verdict.
      const thresholdFrom = (text) => { const m = (text || "").match(/threshold[^0-9]*?(\d+)/i) || (text || "").match(/need\s*[≤<]=?\s*(\d+)/i); return m ? Number(m[1]) : null; };
      const drive = async (forcedMortal) => {
        const n0 = game.messages.size;
        await SR.executeDeathSave({ actorId: a.id, tokenId: null, sceneId, mortalLevel: forcedMortal });
        // find the death-save-result card among THIS actor's messages posted by this call (scope to the
        // fixture's speaker so a stray card from a leftover combat can't be sampled as the result).
        const fresh = game.messages.contents.slice(n0).filter(m => m.speaker?.actor === a.id);
        const card = [...fresh].reverse().find(m => /death-save-result|threshold/.test(m?.content || "")) ?? fresh.at(-1);
        await a.update({ "system.damage": 0 }).catch(() => {});
        return thresholdFrom(card?.content) ?? thresholdFrom(card?.flavor);
      };
      const D = Math.max(1, Math.min(3, bt - 1));   // keep both thresholds >= 1 (no auto-death branch)
      const t0 = await drive(0);
      const tD = await drive(D);
      ok(`H2 bt read (${bt}) + thresholds parsed`, Number.isFinite(t0) && Number.isFinite(tD), `t0=${t0}, t${D}=${tD}`);
      ok(`H2 threshold(0) = bt`, t0 === bt, `${t0} vs bt ${bt}`);
      ok(`H2 threshold shifts by forced mortal (Δ=${D})`, (t0 - tD) === D, `t0-tD = ${t0 - tD}`);
    } catch (e) { out.error = e?.stack || e?.message || String(e); }
    finally { try { if (a) await a.delete(); } catch {} }
    return out;
  });

  if (R.error) { console.error("IN-PAGE ERROR:", R.error); failures++; }
  console.log("Group H combat correctness\n" + R.checks.map(c => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(44)} got=${c.got}`).join("\n"));
  failures += R.checks.filter(c => !c.pass).length;
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  process.exitCode = 2;
} finally {
  await browser.close();
}
