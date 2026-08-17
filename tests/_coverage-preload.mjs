/** Env-gated Chromium JS-coverage hook for the keeper battery.
 *
 *  Loaded with `node --import <this file> tests/<suite>.mjs`. It touches NO suite source: every
 *  keeper does `import { chromium } from "@playwright/test"` and resolves that specifier from
 *  `tests/node_modules`, so this preload and the suite share ONE `chromium` object. Wrapping its
 *  `launch` here therefore reaches all 135 browser suites identically, and the two pure node
 *  suites (which never import playwright) are untouched.
 *
 *  Inert unless CP_COVERAGE=1. When armed it starts JS coverage on every page at creation time
 *  (resetOnNavigation:false, so the /join -> /game navigation does not discard it), and on page or
 *  browser close harvests the entries, keeps only URLs under /modules/cp2020-augmented/, drops the
 *  `source` payload (recording its length so the merge step can prove the served bytes match the
 *  repo file), and writes the running total to import-staging/coverage/<suite>.json after every
 *  harvest — an incremental write, so a suite that calls process.exit() without closing its
 *  browser still leaves whatever it had collected.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

if (process.env.CP_COVERAGE === "1") {
  const URL_FILTER = "/modules/cp2020-augmented/";
  const outDir = path.resolve(process.env.CP_COVERAGE_DIR || "import-staging/coverage");
  const suite =
    process.env.CP_COVERAGE_SUITE ||
    path.basename(process.argv[1] || "unknown-suite", ".mjs");
  const outFile = path.join(outDir, `${suite}.json`);

  fs.mkdirSync(outDir, { recursive: true });

  /** Every filtered entry harvested from every page this process opened. */
  const collected = [];
  let pagesInstrumented = 0;
  let pagesHarvested = 0;

  const flush = () => {
    try {
      fs.writeFileSync(
        outFile,
        JSON.stringify({ suite, pagesInstrumented, pagesHarvested, entries: collected })
      );
    } catch (e) {
      process.stderr.write(`[cp-coverage] write failed: ${e.message}\n`);
    }
  };

  const harvest = async (page) => {
    if (!page.__cpCovArmed || page.__cpCovHarvested) return;
    page.__cpCovHarvested = true;
    try {
      const entries = await page.coverage.stopJSCoverage();
      for (const e of entries) {
        if (!e.url || !e.url.includes(URL_FILTER)) continue;
        collected.push({
          url: e.url,
          srcLen: typeof e.source === "string" ? e.source.length : null,
          functions: e.functions
        });
      }
      pagesHarvested++;
      flush();
    } catch (e) {
      process.stderr.write(`[cp-coverage] harvest failed: ${e.message}\n`);
    }
  };

  const instrument = async (page) => {
    // Playwright's own browser.newPage() calls the (patched) browser.newContext() and then that
    // context's (patched) newPage(), so the outer wrapper sees an already-armed page. Arm once.
    if (page.__cpCovArmed) return page;
    try {
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      page.__cpCovArmed = true;
      pagesInstrumented++;
      const origClose = page.close.bind(page);
      page.close = async (...a) => {
        await harvest(page);
        return origClose(...a);
      };
    } catch (e) {
      process.stderr.write(`[cp-coverage] arm failed: ${e.message}\n`);
    }
    return page;
  };

  /** Wrap a page-producing method (browser.newPage / context.newPage). */
  const wrapNewPage = (holder) => {
    const orig = holder.newPage.bind(holder);
    holder.newPage = async (...a) => instrument(await orig(...a));
  };

  /** Wrap a closer so every page it owns is harvested first. */
  const wrapClose = (holder) => {
    const orig = holder.close.bind(holder);
    holder.close = async (...a) => {
      try {
        const ctxs = typeof holder.contexts === "function" ? holder.contexts() : [holder];
        for (const c of ctxs) for (const p of c.pages?.() ?? []) await harvest(p);
      } catch {}
      flush();
      return orig(...a);
    };
  };

  const origLaunch = chromium.launch.bind(chromium);
  chromium.launch = async (...a) => {
    const browser = await origLaunch(...a);
    wrapNewPage(browser);
    wrapClose(browser);
    const origNewContext = browser.newContext.bind(browser);
    browser.newContext = async (...c) => {
      const ctx = await origNewContext(...c);
      wrapNewPage(ctx);
      wrapClose(ctx);
      return ctx;
    };
    return browser;
  };

  // Backstop for suites that exit without closing: whatever was harvested is already on disk,
  // but write once more so an empty run still leaves a file the merge step can account for.
  process.on("exit", flush);
}
