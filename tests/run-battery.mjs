/** Serial runner for the whole keeper battery.
 *
 *  Every keeper in tests/ is a standalone script with no test runner and three different
 *  verdict-printing idioms, so this runner spawns each one as its own child process, lets it own
 *  its browser and its world fixtures, and treats the EXIT CODE as the verdict (the only universal
 *  signal). Pass/fail line counts are scraped as supporting detail, not as the verdict.
 *
 *  It never stops on a red: a failing suite is recorded and the battery moves on, so one run
 *  yields one complete picture.
 *
 *  Usage (from the module root):
 *    node tests/run-battery.mjs
 *    node tests/run-battery.mjs --only vehicle          # substring filter on the suite name
 *    node tests/run-battery.mjs --list                  # print the resolved order and exit
 *    node tests/run-battery.mjs --no-guard              # skip the world-health pass entirely
 *    CP_BATTERY_HEAL_EVERY=12 node tests/run-battery.mjs # world-health cadence (0 = only after a red)
 *    CP_COVERAGE=1 node tests/run-battery.mjs           # arm the Chromium JS-coverage preload
 *
 *  Env: FVTT_URL (default http://localhost:30004), FVTT_RIG_PASSWORD (passed through to the
 *  keepers, which carry their own inline rig default — this runner never stores a password),
 *  CP_BATTERY_TIMEOUT_MS (the DEFAULT per-suite kill deadline, 420000), and
 *  CP_BATTERY_TIMEOUT_OVERRIDES="<suite>=<ms>,<suite>=<ms>" (per-suite allowances added to the
 *  SUITE_TIMEOUT_MS table below, which already carries the suites known to need longer).
 *
 *  Artifacts (all under the untracked import-staging/):
 *    import-staging/battery-logs/<suite>.log   full stdout+stderr of that suite
 *    import-staging/battery-logs/_summary.tsv  one row per suite, appended as each finishes
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LOG_DIR = path.join(ROOT, "import-staging", "battery-logs");
const PRELOAD = path.join(HERE, "_coverage-preload.mjs");
const TIMEOUT_MS = Number(process.env.CP_BATTERY_TIMEOUT_MS || 420000);

/**
 * PER-SUITE kill deadlines, for the suites that legitimately need longer than the default.
 *
 * ⚠ WHY THIS EXISTS. A suite killed at the deadline loses EVERYTHING it printed — the child's output
 * is only written to its log on close — so an over-deadline suite leaves an EMPTY log and reads as a
 * mysterious hang rather than as "needed more time". fx-rail was killed exactly that way for the whole
 * first coverage baseline: it runs 543–636 s of real Sequencer pacing and the 420 s default cut it off
 * mid-flight at 0 checks recorded. Raising the GLOBAL default instead would give every genuinely-hung
 * suite an extra 10 minutes of nothing, so the allowance is granted by name.
 *
 * Keys are suite names with or without the `.mjs` suffix; values are milliseconds. A suite absent from
 * the table gets TIMEOUT_MS. `CP_BATTERY_TIMEOUT_OVERRIDES="name=ms,name=ms"` adds to / overrides the
 * table at the command line without editing this file.
 */
const SUITE_TIMEOUT_MS = {
  // ~640 s observed worst case + headroom for a slower rig; it is pacing, not a hang.
  "cp2020-augmented-fx-rail": 1_200_000,
};
for (const pair of String(process.env.CP_BATTERY_TIMEOUT_OVERRIDES || "").split(",")) {
  const [k, v] = pair.split("=").map((s) => (s || "").trim());
  if (k && Number(v) > 0) SUITE_TIMEOUT_MS[k.replace(/\.mjs$/, "")] = Number(v);
}
const timeoutFor = (name) => SUITE_TIMEOUT_MS[name] ?? TIMEOUT_MS;

/**
 * Suites that certify a DIFFERENT core than the battery's target. The v13 spread-zone keeper asserts
 * the MeasuredTemplates backend and can only run against the v13 rig; pointed at the v14 rig it fails
 * its own §0 detect on purpose, which the battery then carried as a RED for a product that was never
 * being tested (2026-09-15). Each entry names the rig it needs; the runner probes it once and, when it
 * does not answer, records SKIPPED with the reason instead of running the suite against the wrong core.
 * SKIPPED is its own verdict - not GREEN (nothing was certified) and not RED (nothing failed) - and the
 * summary lists it so an unexercised core is visible rather than silently green.
 */
const SUITE_TARGET = {
  "cp2020-augmented-spread-zone-v13": { url: "http://localhost:30003", reason: "templates backend (core v13) rig" },
};
async function rigAnswers(url) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(`${url}/join`, { signal: ctl.signal, redirect: "manual" });
    clearTimeout(timer);
    return res.status > 0 && res.status < 500;
  } catch { return false; }
}

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const listOnly = argv.includes("--list");
/** `--suites a,b,c` runs exactly that set (names with or without .mjs) — for re-running a
 *  disjoint group such as "every suite that was not green last pass". */
const suiteArg = argv.includes("--suites") ? argv[argv.indexOf("--suites") + 1] : null;
const wanted = suiteArg
  ? new Set(suiteArg.split(",").map((s) => s.trim().replace(/\.mjs$/, "")).filter(Boolean))
  : null;
/** `--out <name>` writes the summary to that filename instead of _summary.tsv. */
const outName = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "_summary.tsv";

/** Deterministic (alphabetical) order; helpers prefixed `_` and this runner are not suites. */
const suites = fs
  .readdirSync(HERE)
  .filter((f) => f.endsWith(".mjs"))
  .filter((f) => !f.startsWith("_") && f !== "run-battery.mjs")
  .filter((f) => (only ? f.includes(only) : true))
  .filter((f) => (wanted ? wanted.has(f.replace(/\.mjs$/, "")) : true))
  .sort();

if (listOnly) {
  suites.forEach((s, i) => console.log(String(i + 1).padStart(3), s));
  console.log(`\n${suites.length} suites`);
  process.exit(0);
}

fs.mkdirSync(LOG_DIR, { recursive: true });
const summaryPath = path.join(LOG_DIR, outName);
const HEADER = "suite\tverdict\texit\tpass\tfail\tsecs\tresultLine\n";

/** Scrape the verdict idioms in use across the battery:
 *    "  PASS  name" / "  PASS: name" / "  PASS ✅ name"   (rig keepers)
 *    "  ✅ name" / "  ❌ name"                             (rig keepers, glyph-only variant)
 *    "  ok   name" + a trailing "N passed, M failed"      (the pure node suites)
 *  Lines like "RESULT: PASS" are excluded by the leading-whitespace anchor. A trailing
 *  "N passed, M failed" tally is authoritative when present. */
function scrape(text) {
  let pass = 0;
  let fail = 0;
  let resultLine = "";
  let tally = null;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s{0,6}(\[?(PASS|ok)\b|✅)/.test(raw)) pass++;
    else if (/^\s{0,6}(\[?(FAIL|not ok)\b|❌)/.test(raw)) fail++;
    if (/^\s*(RESULT|VERDICT)\b/i.test(raw) || /\bALL GREEN\b/.test(raw)) resultLine = raw.trim().slice(0, 90);
    const m = raw.match(/^\s*(\d+)\s+passed,\s+(\d+)\s+failed/);
    if (m) tally = { pass: Number(m[1]), fail: Number(m[2]) };
  }
  if (tally) return { ...tally, resultLine: resultLine || `${tally.pass} passed, ${tally.fail} failed` };
  return { pass, fail, resultLine };
}

/** `--rescrape` recomputes the pass/fail columns from the saved per-suite logs without re-running
 *  anything, keeping each row's verdict/exit/secs. Use it when the scraper learns a new idiom. */
if (argv.includes("--rescrape")) {
  const rows = fs
    .readFileSync(summaryPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split("\t"));
  let outTsv = HEADER;
  for (const [name, verdict, exit, , , secs] of rows) {
    const logPath = path.join(LOG_DIR, `${name}.log`);
    const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    const { pass, fail, resultLine } = scrape(text);
    outTsv += `${name}\t${verdict}\t${exit}\t${pass}\t${fail}\t${secs}\t${resultLine}\n`;
  }
  fs.writeFileSync(summaryPath, outTsv);
  console.log(`rescraped ${rows.length} rows from the saved logs`);
  process.exit(0);
}

fs.writeFileSync(summaryPath, HEADER);

async function runOne(suite) {
  const name = suite.replace(/\.mjs$/, "");
  const target = SUITE_TARGET[name];
  if (target) {
    const up = await rigAnswers(target.url);
    if (!up) {
      const reason = `${target.reason} not answering at ${target.url}`;
      fs.writeFileSync(path.join(LOG_DIR, `${name}.log`), `SKIPPED by the battery runner: ${reason}\n`);
      fs.appendFileSync(summaryPath, `${name}\tSKIPPED\t-\t0\t0\t0.0\t${reason}\n`);
      console.log(`SKIPPED ${name.padEnd(52)} ${"".padStart(4)}  ${"".padStart(3)}  ${"".padStart(7)}  (${reason})`);
      return { name, verdict: "SKIPPED", code: "-", pass: 0, fail: 0, secs: "0.0", resultLine: reason };
    }
  }
  return new Promise((resolve) => {
    const args = [];
    if (process.env.CP_COVERAGE === "1") args.push("--import", pathToFileURL(PRELOAD).href);
    args.push(path.join("tests", suite));

    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        FVTT_URL: target?.url ?? (process.env.FVTT_URL || "http://localhost:30004"),
        CP_COVERAGE_SUITE: name
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let out = "";
    const grab = (buf) => {
      out += buf.toString();
      if (out.length > 6_000_000) out = out.slice(-4_000_000); // keep the tail of a runaway logger
    };
    child.stdout.on("data", grab);
    child.stderr.on("data", grab);

    let timedOut = false;
    const deadline = timeoutFor(name);
    const timer = setTimeout(() => {
      timedOut = true;
      // Flush what the suite printed BEFORE killing it. Without this a killed suite leaves an empty
      // log — the least informative possible failure, and the reason fx-rail's deadline kill looked
      // like a hang for a whole baseline run. The close handler rewrites this file a moment later.
      try {
        fs.writeFileSync(
          path.join(LOG_DIR, `${name}.log`),
          out + `\n\n*** KILLED by the battery runner at the ${(deadline / 1000).toFixed(0)}s per-suite deadline ***\n`
        );
      } catch { /* the close handler still gets its chance */ }
      child.kill("SIGKILL");
    }, deadline);

    child.on("close", (code) => {
      clearTimeout(timer);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      fs.writeFileSync(path.join(LOG_DIR, `${name}.log`), out);
      const { pass, fail, resultLine } = scrape(out);
      const verdict = timedOut ? "TIMEOUT" : code === 0 ? "GREEN" : "RED";
      const row = { name, verdict, code: timedOut ? "kill" : code, pass, fail, secs, resultLine };
      fs.appendFileSync(
        summaryPath,
        `${name}\t${verdict}\t${row.code}\t${pass}\t${fail}\t${secs}\t${resultLine}\n`
      );
      console.log(
        `${verdict.padEnd(7)} ${name.padEnd(52)} ${String(pass).padStart(4)}P ${String(fail).padStart(3)}F ${secs.padStart(7)}s`
      );
      resolve(row);
    });
  });
}

console.log(`battery: ${suites.length} suites, serial, coverage=${process.env.CP_COVERAGE === "1" ? "ON" : "off"}`);
console.log(`target : ${process.env.FVTT_URL || "http://localhost:30004"}`);
console.log("");

/**
 * WORLD-HEALTH GUARD after a suite that did not exit 0.
 *
 * A suite that throws part-way is precisely the one that skipped its own teardown, and the state it
 * most often leaves behind — no active scene — disarms every canvas-dependent suite BEHIND it. That
 * is not hypothetical: one keeper deleting its active probe scene silently reddened five downstream
 * suites and cost fx-rail two legs for an entire baseline run, and the reds it manufactured looked
 * like defects in code that was fine.
 *
 * Running the pre-flight after EVERY suite would add a join (~10 s × 137) for no reason, so it runs
 * after a red — the exact case where cleanup may not have happened — and otherwise on the fixed
 * cadence set below. `--no-guard` turns both off.
 */
const guardOn = !argv.includes("--no-guard");
const PREFLIGHT = path.join(HERE, "_battery-preflight.mjs");
function healWorld(after) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join("tests", "_battery-preflight.mjs")], {
      cwd: ROOT, env: { ...process.env, FVTT_URL: process.env.FVTT_URL || "http://localhost:30004" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => { out += b.toString(); });
    child.stderr.on("data", (b) => { out += b.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", () => {
      clearTimeout(timer);
      let note = "unreadable";
      try {
        const j = JSON.parse(out.slice(out.indexOf("{")));
        note = `activeScene=${JSON.stringify(j.activeSceneAfter)} canvasReady=${j.canvasReady}`
             + ` strayActors=${j.strayActorsBefore}→${j.strayActorsAfter}`
             + (j.strayScenesBefore?.length ? ` strayScenes=[${j.strayScenesBefore.join(", ")}]→${j.strayScenesAfter}` : "");
      } catch { /* keep "unreadable" */ }
      console.log(`  ↳ world-health guard after ${after}: ${note}`);
      fs.appendFileSync(path.join(LOG_DIR, "_guard.log"), `after ${after}\n${out}\n`);
      resolve();
    });
  });
}
if (guardOn) fs.writeFileSync(path.join(LOG_DIR, "_guard.log"), "");

/**
 * PERIODIC HEAL, not only post-red (added 2026-08-16 from the vacuous-leg audit's battery run).
 *
 * The guard above was reactive: it ran only after a suite exited non-zero. But the world degrades
 * across a long run WHETHER OR NOT anything reds — a suite can leave no active scene, a stray
 * `__PW__` actor or a flipped setting behind and still exit 0 — and the damage lands on whatever
 * runs NEXT. Because the order is alphabetical, that is systematically the tail: in that run FOUR of
 * twelve reds (`visibility`, `vision-upgrades`, `vehicle-seating`, `acpa-seeded-load`) went GREEN on
 * a re-run after nothing but a heal, and all four sit in the `a*`/`v*` tail. Those are phantom reds
 * manufactured by the runner's own scheduling, and each one costs a diagnosis.
 *
 * So the guard also fires on a fixed cadence. `CP_BATTERY_HEAL_EVERY=N` sets it (0 disables the
 * periodic half without disabling the post-red half); the default of 12 costs ~11 joins over a
 * 138-suite battery. A heal that has just run for a red does not immediately run again.
 */
const HEAL_EVERY = Number(process.env.CP_BATTERY_HEAL_EVERY ?? 12);

/**
 * ⭐ THE GAP BETWEEN SUITES — a session, not a process, is what has to be gone.
 *
 * PROVEN 2026-08-26. A suite exits and closes its browser, but the SERVER can still hold that
 * client's session for a moment. The next suite joins as the SAME `Gamemaster` user, and for that
 * moment the world has TWO sessions of one user — which every `activeGM` guard in this module waves
 * through, because those guards compare USER ids (`game.users.activeGM?.id === game.user.id`) and a
 * user is not a session. One relayed write is then performed once per live session: measured at
 * THREE chat cards for a single player-side `requestCoverChew`, with `game.users.filter(u => u.active)`
 * still reporting one "Gamemaster", so nothing in the world state shows the condition.
 *
 * That is why it presents as a phantom red — duplicate documents, duplicate cards, or a
 * read-modify-write race between two copies of the same handler — always in the suite that follows
 * another, never when the suite is run alone.
 *
 * `CP_BATTERY_SUITE_GAP_MS` tunes it; 2500 ms was enough to stop reproducing across repeated pairs.
 * ⛔ THE GAP IS A HARNESS MITIGATION, NOT THE FIX. The module-side hazard is real for a referee with
 * the world open in two tabs; see import-staging/COVER-SOAK-CHEW.md for the proof and the proposal.
 */
const SUITE_GAP_MS = Number(process.env.CP_BATTERY_SUITE_GAP_MS ?? 2500);

const rows = [];
const batteryStart = Date.now();
let sinceHeal = 0;
let firstSuite = true;
for (const s of suites) {
  if (!firstSuite && SUITE_GAP_MS > 0) await new Promise((r) => setTimeout(r, SUITE_GAP_MS));
  firstSuite = false;
  const row = await runOne(s);
  rows.push(row);
  sinceHeal++;
  if (!guardOn || !fs.existsSync(PREFLIGHT)) continue;
  if (row.verdict !== "GREEN" && row.verdict !== "SKIPPED") { await healWorld(row.name); sinceHeal = 0; continue; }
  if (HEAL_EVERY > 0 && sinceHeal >= HEAL_EVERY) {
    await healWorld(`${row.name} [periodic, every ${HEAL_EVERY}]`);
    sinceHeal = 0;
  }
}

const green = rows.filter((r) => r.verdict === "GREEN");
const red = rows.filter((r) => r.verdict === "RED");
const to = rows.filter((r) => r.verdict === "TIMEOUT");
const skipped = rows.filter((r) => r.verdict === "SKIPPED");

console.log("\n" + "=".repeat(96));
console.log("BATTERY SUMMARY");
console.log("=".repeat(96));
console.log("verdict  suite                                                 pass fail    secs");
for (const r of rows) {
  console.log(
    `${r.verdict.padEnd(8)} ${r.name.padEnd(52)} ${String(r.pass).padStart(4)} ${String(r.fail).padStart(4)} ${r.secs.padStart(7)}`
  );
}
console.log("-".repeat(96));
console.log(
  `suites ${rows.length}   GREEN ${green.length}   RED ${red.length}   TIMEOUT ${to.length}   SKIPPED ${skipped.length}   ` +
    `checks ${rows.reduce((a, r) => a + r.pass, 0)}P/${rows.reduce((a, r) => a + r.fail, 0)}F   ` +
    `wall ${((Date.now() - batteryStart) / 60000).toFixed(1)}min`
);
if (red.length || to.length) {
  console.log("\nNOT GREEN:");
  for (const r of [...red, ...to]) console.log(`  ${r.verdict}  ${r.name}  (exit ${r.code}, ${r.fail} failing checks)`);
}
if (skipped.length) {
  console.log("\nSKIPPED (rig for that core not answering - nothing certified):");
  for (const r of skipped) console.log(`  ${r.name}  (${r.resultLine})`);
}
process.exit(0);
