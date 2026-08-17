/** Render import-staging/COVERAGE-MAP.md from the battery summary + the merged coverage map.
 *  Reads import-staging/battery-logs/_summary.tsv and import-staging/coverage/_merged.json.
 *  Prose sections (red classification, blind-spot commentary) are written by hand into the
 *  report after this generates the tables — this script owns only what is mechanically derivable.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const IS = path.join(ROOT, "import-staging");

const merged = JSON.parse(fs.readFileSync(path.join(IS, "coverage", "_merged.json"), "utf8"));
const tsv = fs
  .readFileSync(path.join(IS, "battery-logs", "_summary.tsv"), "utf8")
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((l) => {
    const [suite, verdict, exit, pass, fail, secs, resultLine] = l.split("\t");
    return { suite, verdict, exit, pass: +pass, fail: +fail, secs: +secs, resultLine: resultLine || "" };
  });

const L = [];
const p = (s = "") => L.push(s);

/* ---------- battery summary ---------- */
const green = tsv.filter((r) => r.verdict === "GREEN");
const red = tsv.filter((r) => r.verdict === "RED");
const to = tsv.filter((r) => r.verdict === "TIMEOUT");
const wall = tsv.reduce((a, r) => a + r.secs, 0);

p("## 1. Battery summary — first recorded baseline");
p();
p(`| | |`);
p(`|---|---|`);
p(`| suites run | ${tsv.length} |`);
p(`| GREEN | ${green.length} |`);
p(`| RED | ${red.length} |`);
p(`| TIMEOUT | ${to.length} |`);
p(`| checks | ${tsv.reduce((a, r) => a + r.pass, 0)} pass / ${tsv.reduce((a, r) => a + r.fail, 0)} fail |`);
p(`| wall clock | ${(wall / 60).toFixed(1)} min serial |`);
p();
p("### Per-suite");
p();
p("| suite | verdict | exit | pass | fail | secs |");
p("|---|---|---|---|---|---|");
for (const r of tsv)
  p(`| \`${r.suite}\` | ${r.verdict} | ${r.exit} | ${r.pass} | ${r.fail} | ${r.secs.toFixed(1)} |`);
p();

/* ---------- coverage map ---------- */
p("## 3. Coverage map — worst-covered first");
p();
p(
  `Module JS files: **${merged.repoJsFiles}**. Functions: **${merged.executedFunctions}/${merged.totalFunctions} executed = ${merged.overallPct}%** ` +
    `across ${merged.dumps} suite dumps.`
);
p();

const byArea = new Map();
for (const f of merged.files) {
  const area = f.file.replace(/^module\//, "").includes("/")
    ? f.file.replace(/^module\//, "").split("/")[0]
    : "(root)";
  const a = byArea.get(area) ?? { area, total: 0, ran: 0, files: 0, unloaded: 0 };
  a.total += f.totalFunctions;
  a.ran += f.executedFunctions;
  a.files++;
  if (!f.loaded) a.unloaded++;
  byArea.set(area, a);
}
const areas = [...byArea.values()]
  .map((a) => ({ ...a, pct: a.total ? Math.round((a.ran / a.total) * 1000) / 10 : null }))
  .sort((x, y) => (x.pct ?? 999) - (y.pct ?? 999));

p("### 3a. By feature area");
p();
p("| area | files | never-loaded files | functions | executed | % |");
p("|---|---|---|---|---|---|");
for (const a of areas)
  p(`| \`module/${a.area}\` | ${a.files} | ${a.unloaded} | ${a.total} | ${a.ran} | ${a.pct ?? "-"} |`);
p();

p("### 3b. By file (worst first)");
p();
p("Files with zero functions (pure constant tables) sort last; `loaded` means at least one suite fetched and evaluated the module body.");
p();
p("| file | loaded by | functions | executed | % | never-executed |");
p("|---|---|---|---|---|---|");
const ranked = [...merged.files].sort((a, b) => {
  if (a.totalFunctions === 0 && b.totalFunctions === 0) return a.file.localeCompare(b.file);
  if (a.totalFunctions === 0) return 1;
  if (b.totalFunctions === 0) return -1;
  if (a.pct !== b.pct) return a.pct - b.pct;
  return b.totalFunctions - a.totalFunctions;
});
for (const f of ranked)
  p(
    `| \`${f.file}\` | ${f.loadedBySuites} | ${f.totalFunctions} | ${f.executedFunctions} | ${f.pct ?? "-"} | ${f.neverExecuted.length} |`
  );
p();

p("### 3c. Never-executed functions, per file");
p();
p("Only files with at least one never-executed function appear. Line numbers are 1-based in the repo file.");
p();
for (const f of ranked) {
  if (!f.neverExecuted.length) continue;
  p(`<details><summary><code>${f.file}</code> — ${f.neverExecuted.length} of ${f.totalFunctions} never executed (${f.pct}% covered)</summary>`);
  p();
  for (const n of f.neverExecuted) p(`- L${n.line} \`${n.name}\``);
  p();
  p("</details>");
  p();
}

fs.writeFileSync(path.join(IS, "_coverage-map-generated.md"), L.join("\n"));
console.log(`wrote import-staging/_coverage-map-generated.md (${L.length} lines)`);
console.log(`areas worst-first: ${areas.slice(0, 6).map((a) => `${a.area} ${a.pct}%`).join(", ")}`);
