/**
 * PERF PROBE (not a keeper): measured client boot of the rig world.
 * Fresh browser context per run => cold HTTP cache (first-load scenario).
 *
 * Env: FVTT_URL, FVTT_RIG_PASSWORD, PERF_RUNS (default 3), PERF_LABEL, PERF_OUT (json path)
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig PERF_LABEL=x node <this file>
 */
import { chromium } from "@playwright/test";
import { writeFileSync, existsSync, readFileSync } from "node:fs";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const RUNS = Number(process.env.PERF_RUNS ?? 3);
const LABEL = process.env.PERF_LABEL ?? "unlabeled";
const OUT = process.env.PERF_OUT ?? null;

// Injected before any page script. Stamps performance.now() at each boot phase.
const INIT_SCRIPT = () => {
  window.__perfMarks = { scriptStart: performance.now() };
  const hook = () => {
    if (!window.Hooks) return false;
    window.__perfMarks.hooksAvailable = performance.now();
    Hooks.once("init", () => { window.__perfMarks.init = performance.now(); });
    Hooks.once("setup", () => { window.__perfMarks.setup = performance.now(); });
    Hooks.once("ready", () => { window.__perfMarks.ready = performance.now(); });
    Hooks.once("canvasReady", () => { window.__perfMarks.canvasReady = performance.now(); });
    return true;
  };
  if (!hook()) {
    const iv = setInterval(() => { if (hook()) clearInterval(iv); }, 2);
  }
};

async function oneBoot(runIdx) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.addInitScript(INIT_SCRIPT);
  const page = await ctx.newPage();
  const errors = [];
  const warns = [];
  page.on("console", m => {
    const t = m.text();
    if (m.type() === "error") errors.push(t);
    if (m.type() === "warning") warns.push(t);
  });
  page.on("pageerror", e => errors.push(e.message));

  await page.goto(`${URL}/join`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('select[name="userid"]', { timeout: 60000 });
  await page.evaluate(() => {
    const sel = document.querySelector('select[name="userid"]');
    sel.value = [...sel.options].find(o => /gamemaster/i.test(o.textContent)).value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.fill('input[name="password"]', PW);

  const tSubmit = Date.now();
  await page.click('button[name="join"]');
  await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 300000 });
  const tGameReady = Date.now();
  let tCanvasReady = null;
  try {
    await page.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 300000 });
    tCanvasReady = Date.now();
  } catch { /* canvas may be disabled */ }

  const inPage = await page.evaluate(() => {
    const m = { ...window.__perfMarks };
    const nav = performance.getEntriesByType("navigation")[0] ?? {};
    const res = performance.getEntriesByType("resource");
    const agg = (pred) => {
      const rows = res.filter(r => pred(r.name));
      return {
        count: rows.length,
        bytes: rows.reduce((s, r) => s + (r.encodedBodySize || 0), 0),
        decodedBytes: rows.reduce((s, r) => s + (r.decodedBodySize || 0), 0),
        durationSum: Math.round(rows.reduce((s, r) => s + r.duration, 0)),
        wallSpan: rows.length
          ? Math.round(Math.max(...rows.map(r => r.responseEnd)) - Math.min(...rows.map(r => r.startTime)))
          : 0,
      };
    };
    return {
      marks: m,
      nav: {
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd ?? 0),
        loadEvent: Math.round(nav.loadEventEnd ?? 0),
        responseEnd: Math.round(nav.responseEnd ?? 0),
      },
      resources: {
        augmented: agg(n => n.includes("/modules/cp2020-augmented/")),
        allModules: agg(n => n.includes("/modules/")),
        systemCp2020: agg(n => n.includes("/systems/cyberpunk2020/")),
        all: agg(() => true),
      },
      counts: {
        actors: game.actors.size,
        actorItems: game.actors.reduce((s, a) => s + a.items.size, 0),
        messages: game.messages.size,
        augmentedActive: !!game.modules.get("cp2020-augmented")?.active,
        activeScene: game.scenes.active?.name ?? null,
      },
      jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    };
  });

  await ctx.close();
  await browser.close();

  const m = inPage.marks;
  const rel = (a, b) => (m[a] != null && m[b] != null) ? Math.round(m[b] - m[a]) : null;
  return {
    run: runIdx,
    label: LABEL,
    wall_submit_to_gameReady_ms: tGameReady - tSubmit,
    wall_submit_to_canvasReady_ms: tCanvasReady ? tCanvasReady - tSubmit : null,
    page_navStart_to_hooks_ms: m.hooksAvailable != null ? Math.round(m.hooksAvailable) : null,
    page_navStart_to_init_ms: m.init != null ? Math.round(m.init) : null,
    page_navStart_to_setup_ms: m.setup != null ? Math.round(m.setup) : null,
    page_navStart_to_ready_ms: m.ready != null ? Math.round(m.ready) : null,
    page_navStart_to_canvasReady_ms: m.canvasReady != null ? Math.round(m.canvasReady) : null,
    phase_hooks_to_init_ms: rel("hooksAvailable", "init"),   // esmodule fetch+parse+eval window
    phase_init_to_setup_ms: rel("init", "setup"),
    phase_setup_to_ready_ms: rel("setup", "ready"),          // world doc construction + prepareData
    nav: inPage.nav,
    resources: inPage.resources,
    counts: inPage.counts,
    jsHeapMB: inPage.jsHeapMB,
    consoleErrors: errors.length,
    consoleWarnings: warns.length,
    sampleErrors: errors.slice(0, 3),
    invalidDocWarnings: warns.filter(w => /invalid|not a valid|sub-type|subtype/i.test(w)).length,
  };
}

const results = [];
for (let i = 1; i <= RUNS; i++) {
  const r = await oneBoot(i);
  results.push(r);
  console.log(`[${LABEL}] run ${i}: gameReady ${r.wall_submit_to_gameReady_ms}ms  canvasReady ${r.wall_submit_to_canvasReady_ms}ms  ` +
    `| page ready ${r.page_navStart_to_ready_ms}ms  hooks->init ${r.phase_hooks_to_init_ms}  init->setup ${r.phase_init_to_setup_ms}  setup->ready ${r.phase_setup_to_ready_ms}` +
    ` | actors ${r.counts.actors} items ${r.counts.actorItems} mod ${r.counts.augmentedActive} errs ${r.consoleErrors}`);
}

const med = (arr) => {
  const v = arr.filter(x => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const summary = {
  label: LABEL,
  runs: RUNS,
  median: {
    gameReady: med(results.map(r => r.wall_submit_to_gameReady_ms)),
    canvasReady: med(results.map(r => r.wall_submit_to_canvasReady_ms)),
    pageReady: med(results.map(r => r.page_navStart_to_ready_ms)),
    hooks_to_init: med(results.map(r => r.phase_hooks_to_init_ms)),
    init_to_setup: med(results.map(r => r.phase_init_to_setup_ms)),
    setup_to_ready: med(results.map(r => r.phase_setup_to_ready_ms)),
  },
  results,
};
console.log("MEDIAN " + JSON.stringify(summary.median));

if (OUT) {
  const all = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
  all.push(summary);
  writeFileSync(OUT, JSON.stringify(all, null, 2));
  console.log(`appended -> ${OUT}`);
}
