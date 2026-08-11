/**
 * Catalog-index laziness keeper (perf audit S1).
 *
 * `module/shop/catalog.js` memoizes the compendium catalog index behind `getCatalogIndex()`, and the
 * only in-module consumer (`CatalogBrowser._prepareContext`) awaits it. A warm-up call used to fire
 * from `registerShopHooks` at `ready`, so every client walked EVERY Item compendium in the
 * installation — one field-projected `getIndex()` server request per pack — whether or not the shop
 * was ever opened. That warm-up is removed; the index must now build on first genuine demand.
 *
 * Probe: `CompendiumCollection#getIndex` is wrapped BEFORE any page script (addInitScript) and each
 * call is attributed by caller-stack URL, so the module's builder is separated from the host system's
 * own shop code (this rig runs the 1.2.1-beta fork, which carries a shop catalog of its own and still
 * warms it at ready). Attribution by stack measures the real server traffic, not a memo flag that the
 * change itself flips.
 *
 *   L1  boot window (game.ready + canvas.ready + settle, shop never opened)
 *         → ZERO index requests attributable to the module catalog builder
 *   L2  first demand (await the exported accessor) → the build runs NOW and returns a populated,
 *         name-sorted index that includes rows from a module pack
 *   L3  second access → same promise result, no second wave of index requests
 *
 * Assertions go through the module's own imported accessor rather than a sidebar click: the host
 * system registers a shop of its own on this rig, so a UI click is ambiguous about which layer built
 * what. The accessor is the exact function the shop app awaits.
 *
 * Run: FVTT_URL=http://localhost:30003 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-perf-catalog-lazy.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30003";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const MOD_SRC = "/modules/cp2020-augmented/module/shop/catalog.js";
const SETTLE_MS = 4000;   // generous window: a boot-time build would have issued its requests well inside this

/** Wrap CompendiumCollection#getIndex before any page script; tag each call with its caller source. */
const PROBE = (modSrc) => {
  Error.stackTraceLimit = 60;
  window.__cpaIdx = { calls: [], patchedAt: null };
  const record = (packId) => {
    let stack = "";
    try { stack = new Error().stack || ""; } catch { /* stack unavailable */ }
    window.__cpaIdx.calls.push({
      pack: packId,
      t: performance.now(),
      fromModule: stack.includes(modSrc),
      fromHostSystem: stack.includes("/systems/cyberpunk2020/module/shop/catalog.js"),
      gameReady: !!window.game?.ready
    });
  };
  const patch = () => {
    const C = globalThis.foundry?.documents?.collections?.CompendiumCollection;
    if (!C?.prototype?.getIndex || C.prototype.__cpaIdxWrapped) return !!C?.prototype?.__cpaIdxWrapped;
    const orig = C.prototype.getIndex;
    C.prototype.getIndex = function (...args) {
      try { record(this?.collection ?? this?.metadata?.id ?? "?"); } catch { /* never break the call */ }
      return orig.apply(this, args);
    };
    C.prototype.__cpaIdxWrapped = true;
    window.__cpaIdx.patchedAt = performance.now();
    return true;
  };
  if (!patch()) {
    const iv = setInterval(() => { if (patch()) clearInterval(iv); }, 1);
    setTimeout(() => clearInterval(iv), 120000);
  }
};

async function joinAs(page, match, pws) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const s = page.locator('select[name="userid"]');
  await s.waitFor({ state: "visible", timeout: 60000 });
  const us = await s.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  const u = us.find(x => match.test(x.l));
  if (!u) throw new Error("no user matching " + match);
  for (const pw of pws) {
    await s.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([page.waitForNavigation({ url: /\/game/, timeout: 20000 }).catch(() => {}), page.locator('button[name="join"]').click()]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 60000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await s.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("join failed " + u.l);
}

const b = await chromium.launch({ headless: true });
let pass = false; const log = []; const errors = [];
try {
  const ctx = await b.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.addInitScript(PROBE, MOD_SRC);
  const gm = await ctx.newPage();
  gm.on("pageerror", e => log.push("PAGEERR " + e.message));
  gm.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await joinAs(gm, /gamemaster/i, [GM_PW]);
  await gm.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 120000 }).catch(() => {});
  await gm.waitForTimeout(SETTLE_MS);

  const r = await gm.evaluate(async ({ modSrc }) => {
    const checks = []; const chk = (label, cond, got) => checks.push({ label, ok: !!cond, got });
    const probe = window.__cpaIdx;
    const ours = () => probe.calls.filter(c => c.fromModule).length;
    const hosts = () => probe.calls.filter(c => c.fromHostSystem).length;

    // The probe must actually be installed, or every "zero calls" reading below is vacuous.
    chk("probe: index-request wrapper installed before boot", probe.patchedAt != null && probe.calls.length > 0,
      `patchedAt=${probe.patchedAt} totalCalls=${probe.calls.length}`);
    chk("probe: module active on this rig", game.modules.get("cp2020-augmented")?.active === true,
      String(game.modules.get("cp2020-augmented")?.active));
    const shopWindows = [...foundry.applications.instances.values()].filter(w => w.constructor?.name === "CatalogBrowser").length;
    chk("probe: shop app never opened during boot", shopWindows === 0, shopWindows);

    // ── L1: boot window is free of module-attributable index requests ────────────────────────
    const bootOurs = ours();
    const bootHost = hosts();
    chk("L1 boot window: 0 index requests attributable to the module catalog builder",
      bootOurs === 0, `${bootOurs} (host-system builder issued ${bootHost}; total ${probe.calls.length})`);

    // ── L2: first demand builds it ───────────────────────────────────────────────────────────
    const CAT = await import(modSrc);
    const before = ours();
    const t0 = performance.now();
    const all = await CAT.getCatalogIndex();
    const buildMs = Math.round(performance.now() - t0);
    const afterFirst = ours();
    chk("L2 demand: awaiting the accessor issues the pack index requests now",
      afterFirst > before, `${before} → ${afterFirst} in ${buildMs}ms`);
    chk("L2 demand: index is populated", Array.isArray(all) && all.length > 0, all?.length);
    // A module pack must be represented — pick a real row from one and find it back in the index.
    const pack = game.packs.get("cp2020-augmented.supplement-pistols");
    const idx = pack ? await pack.getIndex() : null;
    const sample = idx ? [...idx].find(e => e.name) : null;
    const found = sample ? all.find(row => row.key === `cp2020-augmented.supplement-pistols.${sample._id}`) : null;
    chk("L2 demand: a module pack row is present by name",
      !!found && found.name === sample.name, sample ? `${sample.name} → ${found ? found.name : "MISSING"}` : "no sample");
    const sorted = all.every((row, i) => i === 0 || all[i - 1].name.localeCompare(row.name) <= 0);
    chk("L2 demand: rows are name-sorted", sorted, sorted ? "" : "out of order");

    // ── L3: memo reuse ───────────────────────────────────────────────────────────────────────
    const beforeSecond = ours();
    const all2 = await CAT.getCatalogIndex();
    const afterSecond = ours();
    chk("L3 reuse: second access issues no further index requests", afterSecond === beforeSecond, `${beforeSecond} → ${afterSecond}`);
    chk("L3 reuse: second access returns the same memoized rows", all2 === all, all2 === all ? "" : "different array");

    return {
      ok: checks.every(c => c.ok), checks,
      stats: { bootOurs, bootHost, totalCalls: probe.calls.length, indexRows: all?.length ?? 0, buildMs }
    };
  }, { modSrc: MOD_SRC });

  for (const c of r.checks || []) log.push(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}${c.ok ? "" : "  -> got " + c.got}`);
  log.push(`  INFO  boot module-attributed requests ${r.stats.bootOurs} | boot host-system requests ${r.stats.bootHost} | ` +
    `all wrapped calls ${r.stats.totalCalls} | index rows ${r.stats.indexRows} | on-demand build ${r.stats.buildMs}ms`);
  const noConsoleErr = errors.length === 0;
  log.push(`  ${noConsoleErr ? "PASS" : "FAIL"}  0 console errors${noConsoleErr ? "" : "  -> " + errors.join(" | ")}`);
  pass = r.ok && noConsoleErr && !log.some(l => l.startsWith("PAGEERR"));
} catch (e) { log.push("ERROR " + (e?.stack || e?.message || e)); }
finally { await b.close(); }

console.log(log.join("\n"));
console.log(pass ? "\nRESULT: PASS" : "\nRESULT: FAIL");
process.exit(pass ? 0 : 1);
