/** Merge the per-suite Chromium JS-coverage dumps into one per-file, per-function map of the
 *  module's own JS.
 *
 *  Input : import-staging/coverage/<suite>.json (written by tests/_coverage-preload.mjs)
 *  Output: import-staging/coverage/_merged.json — for every module/**\/*.js file, its function
 *          total, how many ever ran under ANY suite, and the never-executed ones with line
 *          numbers and the suites that at least LOADED the file.
 *
 *  V8 range semantics used here: each entry in `functions` describes one function; `ranges[0]` is
 *  the function's own extent and its `count` is how many times the function itself was entered.
 *  count === 0 in every suite => that function never ran. The synthetic top-level entry (an empty
 *  name spanning offset 0 to the end of file) is the module body itself, so it is reported
 *  separately as "file loaded" rather than counted as a function.
 *
 *  Offsets are UTF-16 code-unit offsets into the SERVED source. The dumps carry each served
 *  script's length, so a repo file whose length differs is flagged rather than silently mapped to
 *  wrong lines.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const COV_DIR = path.join(ROOT, "import-staging", "coverage");

/** Every module JS file that exists in the repo, so files NO suite ever loaded still appear. */
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith(".js")) acc.push(full);
  }
  return acc;
}
const repoFiles = walk(path.join(ROOT, "module")).map((f) =>
  path.relative(ROOT, f).split(path.sep).join("/")
);

/** relPath -> { functions: Map<key, {name, start, end, count}>, loadedBy:Set, srcLens:Set } */
const files = new Map();
for (const rel of repoFiles) {
  files.set(rel, { functions: new Map(), loadedBy: new Set(), srcLens: new Set(), topLevelRuns: 0 });
}

const dumps = fs
  .readdirSync(COV_DIR)
  .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
  .sort();

let entriesSeen = 0;
const unmatchedUrls = new Set();

for (const d of dumps) {
  const suite = d.replace(/\.json$/, "");
  let j;
  try {
    j = JSON.parse(fs.readFileSync(path.join(COV_DIR, d), "utf8"));
  } catch {
    continue; // a truncated dump from a killed suite
  }
  for (const e of j.entries ?? []) {
    entriesSeen++;
    const m = e.url.match(/\/modules\/cp2020-augmented\/(.*?)(?:\?.*)?$/);
    if (!m) continue;
    const rel = m[1];
    if (!files.has(rel)) {
      // A served path with no repo counterpart (a stale serve copy would show up here).
      if (rel.endsWith(".js")) unmatchedUrls.add(rel);
      continue;
    }
    const f = files.get(rel);
    f.loadedBy.add(suite);
    if (e.srcLen != null) f.srcLens.add(e.srcLen);
    for (const fn of e.functions ?? []) {
      const r0 = fn.ranges?.[0];
      if (!r0) continue;
      const isTopLevel = r0.startOffset === 0 && fn.functionName === "";
      if (isTopLevel) {
        f.topLevelRuns += r0.count;
        continue;
      }
      const key = `${r0.startOffset}:${r0.endOffset}`;
      const prev = f.functions.get(key);
      if (prev) {
        prev.count += r0.count;
        if (!prev.name && fn.functionName) prev.name = fn.functionName;
        if (r0.count > 0) prev.ranBy.add(suite);
      } else {
        f.functions.set(key, {
          name: fn.functionName || "",
          start: r0.startOffset,
          end: r0.endOffset,
          count: r0.count,
          ranBy: new Set(r0.count > 0 ? [suite] : [])
        });
      }
    }
  }
}

/** Offset -> 1-based line, plus the source text of that line (names anonymous functions). */
function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return (off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const out = [];
for (const rel of repoFiles) {
  const f = files.get(rel);
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const toLine = lineIndex(src);
  const lengthMismatch = f.srcLens.size > 0 && !f.srcLens.has(src.length);

  const fns = [...f.functions.values()]
    .map((fn) => {
      // Name anonymous functions by the code at their head, so the map stays actionable.
      let label = fn.name;
      if (!label) {
        const head = src.slice(fn.start, Math.min(fn.end, fn.start + 70)).replace(/\s+/g, " ").trim();
        label = `<anon> ${head.slice(0, 60)}`;
      }
      return { name: label, line: toLine(fn.start), executed: fn.count > 0, count: fn.count };
    })
    .sort((a, b) => a.line - b.line);

  const total = fns.length;
  const ran = fns.filter((x) => x.executed).length;
  out.push({
    file: rel,
    lines: src.split("\n").length,
    loaded: f.loadedBy.size > 0,
    loadedBySuites: f.loadedBy.size,
    moduleBodyRuns: f.topLevelRuns,
    totalFunctions: total,
    executedFunctions: ran,
    pct: total === 0 ? null : Math.round((ran / total) * 1000) / 10,
    lengthMismatch,
    neverExecuted: fns.filter((x) => !x.executed).map((x) => ({ name: x.name, line: x.line }))
  });
}

const summary = {
  generated: new Date().toISOString(),
  dumps: dumps.length,
  entriesSeen,
  unmatchedServedPaths: [...unmatchedUrls],
  repoJsFiles: repoFiles.length,
  filesNeverLoaded: out.filter((f) => !f.loaded).map((f) => f.file),
  totalFunctions: out.reduce((a, f) => a + f.totalFunctions, 0),
  executedFunctions: out.reduce((a, f) => a + f.executedFunctions, 0),
  files: out
};
summary.overallPct =
  Math.round((summary.executedFunctions / summary.totalFunctions) * 1000) / 10;

fs.writeFileSync(path.join(COV_DIR, "_merged.json"), JSON.stringify(summary, null, 1));

console.log(`dumps ${dumps.length}  entries ${entriesSeen}`);
console.log(`repo module JS files ${repoFiles.length}  never loaded ${summary.filesNeverLoaded.length}`);
console.log(`functions ${summary.executedFunctions}/${summary.totalFunctions} executed = ${summary.overallPct}%`);
if (summary.unmatchedServedPaths.length)
  console.log(`served paths with no repo file: ${summary.unmatchedServedPaths.join(", ")}`);
const mism = out.filter((f) => f.lengthMismatch);
if (mism.length) console.log(`⚠ served/repo length mismatch (line numbers suspect): ${mism.map((f) => f.file).join(", ")}`);
