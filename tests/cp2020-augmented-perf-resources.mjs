/**
 * PERF PROBE (not a keeper): break down the module's network waterfall on a cold-cache boot.
 * Reports per-extension counts/bytes and the ES-module request WAVE structure (graph depth),
 * which is what serializes over a high-latency link.
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${URL}/join`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('select[name="userid"]');
await page.evaluate(() => {
  const sel = document.querySelector('select[name="userid"]');
  sel.value = [...sel.options].find(o => /gamemaster/i.test(o.textContent)).value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.fill('input[name="password"]', PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 300000 });
await page.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 300000 }).catch(() => {});

const res = await page.evaluate(() => {
  const rows = performance.getEntriesByType("resource")
    .filter(r => r.name.includes("/modules/cp2020-augmented/"))
    .map(r => ({
      path: r.name.split("/modules/cp2020-augmented/")[1].split("?")[0],
      start: Math.round(r.startTime),
      end: Math.round(r.responseEnd),
      dur: Math.round(r.duration),
      enc: r.encodedBodySize,
      dec: r.decodedBodySize,
    }))
    .sort((a, b) => a.start - b.start);

  const byExt = {};
  for (const r of rows) {
    const ext = (r.path.match(/\.([a-z0-9]+)$/i)?.[1] ?? "none").toLowerCase();
    byExt[ext] ??= { count: 0, enc: 0, dec: 0, durSum: 0 };
    byExt[ext].count++; byExt[ext].enc += r.enc; byExt[ext].dec += r.dec; byExt[ext].durSum += r.dur;
  }

  // WAVE structure for the .js graph: group requests whose start time follows the previous
  // wave's completion — each wave is one more level of import-graph depth (one RTT on a real link).
  const js = rows.filter(r => r.path.endsWith(".js"));
  const waves = [];
  for (const r of js) {
    const w = waves[waves.length - 1];
    if (!w || r.start >= w.end) waves.push({ start: r.start, end: r.end, n: 1, files: [r.path] });
    else { w.n++; w.end = Math.max(w.end, r.end); w.files.push(r.path); }
  }

  return {
    totalRequests: rows.length,
    totalEncMB: +(rows.reduce((s, r) => s + r.enc, 0) / 1048576).toFixed(2),
    totalDecMB: +(rows.reduce((s, r) => s + r.dec, 0) / 1048576).toFixed(2),
    byExt,
    jsRequests: js.length,
    jsEncMB: +(js.reduce((s, r) => s + r.enc, 0) / 1048576).toFixed(2),
    jsWallSpanMs: js.length ? Math.max(...js.map(r => r.end)) - Math.min(...js.map(r => r.start)) : 0,
    jsWaveCount: waves.length,
    waves: waves.map((w, i) => ({ wave: i + 1, files: w.n, startMs: w.start, endMs: w.end, spanMs: w.end - w.start })),
    slowestJs: js.slice().sort((a, b) => b.dur - a.dur).slice(0, 8).map(r => `${r.path} ${r.dur}ms ${Math.round(r.enc / 1024)}KB`),
    largestJs: js.slice().sort((a, b) => b.enc - a.enc).slice(0, 8).map(r => `${r.path} ${Math.round(r.enc / 1024)}KB enc / ${Math.round(r.dec / 1024)}KB dec`),
    firstJsStart: js.length ? Math.min(...js.map(r => r.start)) : null,
    lastJsEnd: js.length ? Math.max(...js.map(r => r.end)) : null,
  };
});

console.log(JSON.stringify(res, null, 2));
await browser.close();
