/**
 * Shop pending-render keeper (the catalog index's loading state).
 *
 * `module/shop/catalog.js` builds the compendium catalog index on first demand (see the sibling
 * keeper cp2020-augmented-perf-catalog-lazy.mjs). The build walks every Item pack, so the first shop
 * open used to sit behind that await with nothing on screen — measured ~931ms over 52 pack-index
 * requests on v13 (this rig), against ~4ms and no extra requests on v14, whose indices are already
 * resident at `ready`. The window must now render IMMEDIATELY with a pending panel and swap itself for
 * the real rows when the build resolves. The panel is expected to be imperceptible where the build is
 * genuinely instant; nothing holds it on screen artificially.
 *
 *   P0  probes: the module is active, shopping is enabled, and the window under test is the MODULE's
 *         CatalogBrowser (this rig also carries the host system's own shop code)
 *   L1  cold memo → the window is on screen while the index is still building, showing
 *         `.cp-catalog-loading` + its ring, no rows, and a localized label (no raw key text)
 *   L2  build resolves → the pending panel is GONE and the list carries real compendium rows,
 *         matched by source key + name against a row of the built index
 *   L3  warm memo, second open → the pending panel is never inserted at all (MutationObserver over
 *         the whole open, not a single sampled read)
 *   L4  closed during the build → the resolve lands with no page error and re-renders nothing
 *
 * The build is stretched from the TEST side only (`window.__cpaIndexDelayMs`, a wrapper around
 * CompendiumCollection#getIndex installed before any page script) so the pending window can be read
 * and photographed deterministically instead of raced. Shipped code has no such knob.
 *
 * Screenshots (pending + resolved) are written to CPA_SHOT_DIR, default the module's import-staging.
 *
 * Run: FVTT_URL=http://localhost:30003 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-shop-loading.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.FVTT_URL || "http://localhost:30003";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const CAT_SRC = "/modules/cp2020-augmented/module/shop/catalog.js";
const SET_SRC = "/modules/cp2020-augmented/module/settings.js";
const SHOT_DIR = process.env.CPA_SHOT_DIR ||
  "C:/Users/randa/AppData/Local/FoundryVTT/Data/modules/cp2020-augmented/import-staging";
const BUILD_DELAY_MS = 3500;   // per pack-index call; the packs are requested in parallel, so ≈ one delay overall

/** Test-side only: let the keeper hold the index build open long enough to read/photograph the panel. */
const SLOW_INDEX = () => {
  window.__cpaIndexDelayMs = 0;
  const patch = () => {
    const C = globalThis.foundry?.documents?.collections?.CompendiumCollection;
    if (!C?.prototype?.getIndex || C.prototype.__cpaSlowWrapped) return !!C?.prototype?.__cpaSlowWrapped;
    const orig = C.prototype.getIndex;
    C.prototype.getIndex = async function (...args) {
      const ms = Number(window.__cpaIndexDelayMs) || 0;
      if (ms > 0) await new Promise(r => setTimeout(r, ms));
      return orig.apply(this, args);
    };
    C.prototype.__cpaSlowWrapped = true;
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
let pass = false; const log = []; const errors = []; const pageErrors = [];
try {
  mkdirSync(SHOT_DIR, { recursive: true });
  const ctx = await b.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.addInitScript(SLOW_INDEX);
  const gm = await ctx.newPage();
  gm.on("pageerror", e => pageErrors.push("PAGEERR " + e.message));
  gm.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await joinAs(gm, /gamemaster/i, [GM_PW]);
  await gm.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 120000 }).catch(() => {});

  // ── P0 + L1: open with a cold memo and read the window while the build is still running ─────────
  const cold = await gm.evaluate(async ({ catSrc, setSrc, delayMs }) => {
    window.__cpaChecks = [];
    const chk = (label, cond, got) => window.__cpaChecks.push({ label, ok: !!cond, got: String(got ?? "") });
    const CAT = await import(catSrc);
    const SET = await import(setSrc);
    window.__cpaCAT = CAT;

    chk("P0 probe: module active", game.modules.get("cp2020-augmented")?.active === true,
      game.modules.get("cp2020-augmented")?.active);
    chk("P0 probe: shopping enabled in this world", SET.shoppingEnabled() === true, SET.shoppingEnabled());

    // Cold start: drop the memo and close any window a previous run left behind.
    for (const w of [...foundry.applications.instances.values()]) {
      if (w instanceof CAT.CatalogBrowser) await w.close();
    }
    CAT.clearCatalogIndexCache();
    chk("L1 cold: index reports NOT built before the open", CAT.catalogIndexReady?.() === false,
      String(CAT.catalogIndexReady?.()));

    window.__cpaIndexDelayMs = delayMs;
    const t0 = performance.now();
    // openShopWindow is the entry point every caller routes through, and it hands back the window
    // (the openCatalogBrowser alias does not return it).
    const app = CAT.openShopWindow(null, { view: "catalog" });
    window.__cpaApp = app;
    chk("P0 probe: the opened window is the module's CatalogBrowser",
      app instanceof CAT.CatalogBrowser, app?.constructor?.name);

    // The window must appear FAST — well inside the stretched build — or it is still awaiting the index.
    let root = null;
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline) {
      root = app?.element ?? null;
      if (root && root.isConnected) break;
      await new Promise(r => setTimeout(r, 25));
    }
    const shownMs = Math.round(performance.now() - t0);
    chk("L1 cold: the window is on screen", !!root?.isConnected, `after ${shownMs}ms`);
    chk("L1 cold: it appeared while the index was still building",
      CAT.catalogIndexReady?.() === false && shownMs < delayMs,
      `shown after ${shownMs}ms, build delay ${delayMs}ms, ready=${CAT.catalogIndexReady?.()}`);

    const panel = root?.querySelector(".cp-catalog-loading") ?? null;
    const ring = root?.querySelector(".cp-catalog-spinner") ?? null;
    const label = root?.querySelector(".cp-catalog-loading-label") ?? null;
    chk("L1 cold: the pending panel is rendered", !!panel, panel ? "present" : "ABSENT");
    chk("L1 cold: the panel carries its ring element", !!ring, ring ? "present" : "ABSENT");
    chk("L1 cold: no catalog rows yet", (root?.querySelectorAll(".cp-catalog-row").length ?? -1) === 0,
      root?.querySelectorAll(".cp-catalog-row").length);
    chk("L1 cold: the window frame is up around it (header rendered)", !!root?.querySelector(".cp-shop-header"),
      root?.querySelector(".cp-shop-header") ? "present" : "ABSENT");

    // The ring must actually be an animating disc, not an unstyled empty span.
    const cs = ring ? getComputedStyle(ring) : null;
    chk("L1 cold: the ring is a sized, animated disc",
      !!cs && parseFloat(cs.width) >= 16 && parseFloat(cs.height) >= 16 && cs.animationName !== "none" &&
      parseFloat(cs.animationDuration) > 0,
      cs ? `${cs.width}x${cs.height} animation=${cs.animationName} ${cs.animationDuration}` : "no ring");
    const pcs = panel ? getComputedStyle(panel) : null;
    chk("L1 cold: the panel centres its content in the body",
      !!pcs && pcs.display === "flex" && pcs.alignItems === "center" && pcs.justifyContent === "center",
      pcs ? `${pcs.display}/${pcs.alignItems}/${pcs.justifyContent}` : "no panel");

    // i18n: the label must be the localized value, and no raw key may leak anywhere in the pending DOM.
    const expected = game.i18n.localize("CYBERPUNK.ShopCatalogLoading");
    const text = (label?.textContent ?? "").trim();
    chk("L1 cold: the label key resolves to real text",
      expected !== "CYBERPUNK.ShopCatalogLoading" && expected.length > 0, expected);
    chk("L1 cold: the rendered label is that localized text", text.length > 0 && text === expected, `"${text}"`);
    chk("L1 cold: no raw CYBERPUNK. key anywhere in the pending window",
      !(root?.textContent ?? "").includes("CYBERPUNK."), (root?.textContent ?? "").includes("CYBERPUNK.") ? "raw key present" : "none");

    return { shownMs };
  }, { catSrc: CAT_SRC, setSrc: SET_SRC, delayMs: BUILD_DELAY_MS });

  const pendingShot = join(SHOT_DIR, "shop-loading-spinner.png");
  await gm.screenshot({ path: pendingShot });

  // ── L2: the build lands and the window swaps itself for the real rows ───────────────────────────
  await gm.evaluate(async () => {
    const CAT = window.__cpaCAT, app = window.__cpaApp;
    const chk = (label, cond, got) => window.__cpaChecks.push({ label, ok: !!cond, got: String(got ?? "") });
    const all = await CAT.getCatalogIndex();
    window.__cpaIndexDelayMs = 0;

    // Wait for the re-render the resolve triggers (rows in the DOM), not for a fixed sleep.
    const deadline = performance.now() + 20000;
    let rows = 0;
    while (performance.now() < deadline) {
      rows = app?.element?.querySelectorAll(".cp-catalog-row").length ?? 0;
      if (rows > 0) break;
      await new Promise(r => setTimeout(r, 50));
    }
    const root = app?.element ?? null;
    chk("L2 resolved: index reports built", CAT.catalogIndexReady?.() === true, String(CAT.catalogIndexReady?.()));
    chk("L2 resolved: the pending panel is gone", !root?.querySelector(".cp-catalog-loading"),
      root?.querySelector(".cp-catalog-loading") ? "still present" : "gone");
    chk("L2 resolved: real catalog rows are rendered", rows > 0, rows);

    // Tie a rendered row back to a real compendium document: pick a core row out of the built index
    // and find that exact source key in the list, with the same name.
    const sample = all.find(r => r.canon === "core" && r.packId && r.name) ?? all[0];
    const rowEl = sample ? root?.querySelector(`.cp-catalog-row[data-source-key="${CSS.escape(sample.key)}"]`) : null;
    const nameEl = rowEl?.querySelector(".cp-cat-itemname");
    chk("L2 resolved: a known pack item is present by name",
      !!rowEl && (nameEl?.textContent ?? "").trim() === sample.name,
      sample ? `${sample.key} → "${(nameEl?.textContent ?? "MISSING").trim()}" (want "${sample.name}")` : "no index rows");
    window.__cpaRows = rows;
  });

  const resolvedShot = join(SHOT_DIR, "shop-loading-resolved.png");
  await gm.screenshot({ path: resolvedShot });

  // ── L3 (warm reopen) + L4 (closed mid-build) ────────────────────────────────────────────────────
  const errCountBeforeL4 = errors.length + pageErrors.length;
  await gm.evaluate(async ({ delayMs }) => {
    const CAT = window.__cpaCAT;
    const chk = (label, cond, got) => window.__cpaChecks.push({ label, ok: !!cond, got: String(got ?? "") });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // ── L3: warm memo → the panel must never be inserted, not even for one frame.
    for (const w of [...foundry.applications.instances.values()]) if (w instanceof CAT.CatalogBrowser) await w.close();
    chk("L3 warm: the memo survives the close", CAT.catalogIndexReady?.() === true, String(CAT.catalogIndexReady?.()));
    let inserted = 0;
    const obs = new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches?.(".cp-catalog-loading") || n.querySelector?.(".cp-catalog-loading")) inserted++;
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const app2 = CAT.openShopWindow(null, { view: "catalog" });
    let rows2 = 0;
    const d2 = performance.now() + 20000;
    while (performance.now() < d2) {
      rows2 = app2?.element?.querySelectorAll(".cp-catalog-row").length ?? 0;
      if (rows2 > 0) break;
      await sleep(25);
    }
    await sleep(300);
    obs.disconnect();
    chk("L3 warm: the second open lists rows straight away", rows2 > 0, rows2);
    chk("L3 warm: the pending panel is never inserted", inserted === 0, `${inserted} insertion(s)`);
    await app2?.close();

    // ── L4: close the window while the build runs; the resolve must land on a dead app harmlessly.
    CAT.clearCatalogIndexCache();
    window.__cpaIndexDelayMs = delayMs;
    const app3 = CAT.openShopWindow(null, { view: "catalog" });
    const d3 = performance.now() + 20000;
    while (performance.now() < d3) { if (app3?.element?.querySelector(".cp-catalog-loading")) break; await sleep(25); }
    chk("L4 close-during-build: the pending panel was up when the window was closed",
      !!app3?.element?.querySelector(".cp-catalog-loading"),
      app3?.element?.querySelector(".cp-catalog-loading") ? "panel up" : (app3?.element ? "window up, no panel" : "no element"));
    await app3.close();
    chk("L4 close-during-build: the window is closed before the build resolves",
      app3.rendered === false && CAT.catalogIndexReady?.() === false,
      `rendered=${app3.rendered} ready=${CAT.catalogIndexReady?.()}`);

    await CAT.getCatalogIndex();
    await sleep(600);   // let the resolve leg (and any re-render it might attempt) run
    chk("L4 close-during-build: the resolve did not revive the closed window",
      app3.rendered === false && !app3.element?.isConnected,
      `rendered=${app3.rendered} connected=${!!app3.element?.isConnected}`);
    chk("L4 close-during-build: no pending panel left in the document",
      !document.querySelector(".cp-catalog-loading"),
      document.querySelector(".cp-catalog-loading") ? "panel orphaned" : "none");

    window.__cpaIndexDelayMs = 0;
    for (const w of [...foundry.applications.instances.values()]) if (w instanceof CAT.CatalogBrowser) await w.close();
  }, { delayMs: BUILD_DELAY_MS });

  const checks = await gm.evaluate(() => window.__cpaChecks);
  for (const c of checks) log.push(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}${c.ok ? "" : "  -> got " + c.got}`);
  const l4Clean = (errors.length + pageErrors.length) === errCountBeforeL4;
  log.push(`  ${l4Clean ? "PASS" : "FAIL"}  L4 close-during-build: no new error raised by the resolve${l4Clean ? "" : "  -> " + errors.concat(pageErrors).slice(errCountBeforeL4).join(" | ")}`);
  log.push(`  INFO  window shown after ${cold.shownMs}ms with the build stretched to ${BUILD_DELAY_MS}ms | rows ${await gm.evaluate(() => window.__cpaRows)}`);
  log.push(`  INFO  screenshots: ${pendingShot} | ${resolvedShot}`);
  const noErr = errors.length === 0 && pageErrors.length === 0;
  log.push(`  ${noErr ? "PASS" : "FAIL"}  0 console errors${noErr ? "" : "  -> " + errors.concat(pageErrors).join(" | ")}`);
  pass = checks.every(c => c.ok) && l4Clean && noErr;
} catch (e) { log.push("ERROR " + (e?.stack || e?.message || e)); }
finally { await b.close(); }

console.log(log.join("\n"));
console.log(pass ? "\nRESULT: PASS" : "\nRESULT: FAIL");
process.exit(pass ? 0 : 1);
