/**
 * PAIRWISE COVERING ARRAY for BINARY factors — deterministic, dependency-free.
 *
 * WHAT IT PRODUCES. Given N on/off keys, it returns a small list of ROWS (one value per key) with the
 * property that for EVERY unordered pair of keys, all four value combinations (off/off, off/on, on/off,
 * on/on) appear together in at least one row. That is the standard 2-wise coverage guarantee: it does
 * not exercise every one of the 2^N worlds, it exercises every two-setting INTERACTION, which is the
 * class of defect a settings matrix actually carries (a feature that only misbehaves when its master is
 * off AND some neighbour is on).
 *
 * WHY GREEDY ROW-AT-A-TIME RATHER THAN IPO. The row-at-a-time greedy is a few dozen lines, has no
 * internal state to get wrong, and — crucially for a keeper — is trivially CHECKABLE: `uncoveredPairs()`
 * below re-derives the coverage claim from the finished matrix without reusing any of the construction
 * logic, so the suite can assert the guarantee it is relying on instead of trusting this file. IPO's
 * horizontal and vertical growth phases are much easier to get subtly wrong; with the tie rule below the
 * greedy lands within a couple of rows of the information-theoretic floor anyway (13 rows for 45 binary
 * factors, against a Katona bound of 9).
 *
 * ⭐⭐ THE TIE RULE IS THE WHOLE ALGORITHM, AND THE FIRST VERSION GOT IT WRONG. Filling an undecided key
 * means asking "does `false` or `true` cover more still-missing pairs against the keys this row has
 * already fixed". Very often the answer is NEITHER — early on nothing is covered, so both values score
 * identically, and near the end most keys are irrelevant to the handful of pairs still missing. The
 * original rule resolved every one of those ties to `false`. That single constant is what produced the
 * matrix this replaces: measured at 45 keys, 31 rows whose on-counts ran
 *
 *      0, 44, 23, 23, 22, 20, 20, 21, 16, 17, 11, 7, 2, 2, 1, 1, 1, … 1     (18 rows with ONE switch on)
 *
 * — an all-off row, an all-but-one-on row, and then a long tail of rows that turn on a single switch.
 * Each of those tail rows is a full smoke pass on a live client that exercises almost no interaction,
 * which is the opposite of what a pairwise matrix is for: the DEFECT CLASS being hunted is "feature A
 * misbehaves while feature B is on", and a row with one switch on cannot contain one.
 *
 * The fix is that ties resolve to a deterministic PER-CANDIDATE, PER-KEY bit (an integer hash of the two
 * indices) instead of to a constant. Nothing about coverage changes — a tie is by definition a choice
 * between two equally-covering values — but the rows come out mixed, the candidates put to the
 * best-of-N comparison actually differ from one another, and the matrix converges far faster because a
 * balanced row covers pairs in both directions at once. Same measurement, same 45 keys: 13 rows, every
 * one of them between 22 and 26 switches on. Equal-gain candidates are then broken toward the most
 * BALANCED row, which is what keeps the last rows from drifting sparse as coverage fills up.
 *
 * DETERMINISM is a hard requirement, not a nicety: the suite that consumes this reports failures by ROW
 * INDEX, and a row index means nothing if the matrix is a different one on the next run. There is no
 * randomness anywhere here — the tie bit is a pure function of two integers, the candidate seeds are
 * arithmetically spaced, and every scan runs in key order — so the same key list always yields the same
 * matrix, byte for byte. The self-test asserts that by building each matrix twice.
 *
 * TERMINATION is guaranteed by construction: each candidate row is SEEDED with a still-uncovered pair
 * and keeps it, so the winning row covers at least one new pair, so the loop can run at most `4·C(N,2)`
 * times.
 *
 * Self-check:  node tools/pairwise-gen.mjs --selftest
 *              node tools/pairwise-gen.mjs --keys a,b,c,d      (prints the matrix for a named key list)
 */

/** Canonical key for one (keyIndex, value) × (keyIndex, value) combination, with i < j always. */
function pairId(i, a, j, b) {
  return i < j ? `${i}:${a ? 1 : 0}|${j}:${b ? 1 : 0}` : `${j}:${b ? 1 : 0}|${i}:${a ? 1 : 0}`;
}

/** How many pair combinations a list of N binary keys has in total: 4 per unordered key pair. */
export function totalPairs(n) {
  return 4 * ((n * (n - 1)) / 2);
}

/**
 * Build a 2-wise covering array over `keys`, all of which are treated as binary.
 * @param {string[]} keys  the setting keys, in the order the caller wants them reported
 * @returns {Array<Record<string, boolean>>} rows, each a full key → boolean map
 */
export function pairwiseBinary(keys) {
  const n = keys.length;
  if (n === 0) return [];
  if (n === 1) return [{ [keys[0]]: false }, { [keys[0]]: true }];

  const covered = new Set();
  const want = totalPairs(n);
  const rows = [];

  /** Every pair combination no row has produced yet, in canonical key order. */
  const listUncovered = () => {
    const out = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        for (const a of [false, true]) {
          for (const b of [false, true]) {
            if (!covered.has(pairId(i, a, j, b))) out.push({ i, a, j, b });
          }
        }
      }
    }
    return out;
  };

  /**
   * The tie bit: a pure integer hash of (candidate index, key index) → boolean. This is what replaces
   * "ties → false". It is not randomness — it is a fixed, reproducible function, and the self-test
   * proves it by rebuilding every matrix and comparing byte for byte.
   */
  const tieBit = (candidate, key) => {
    let h = Math.imul(candidate + 1, 0x9E3779B1) ^ Math.imul(key + 1, 0x85EBCA6B);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2545F491);
    return ((h >>> 0) & 1) === 1;
  };

  /**
   * Grow one full row out of a seeded pair. The seeded two keys are fixed; the rest are filled in the
   * order that starts at a candidate-dependent offset and wraps, each taking whichever value covers more
   * still-missing pairs against the keys already fixed in this row — and on a TIE, the candidate's own
   * tie bit for that key.
   * @param seed       the (key i = a, key j = b) combination this row exists to cover
   * @param candidate  which candidate of this round's sweep this is; varies the fill order and the ties
   */
  const growFrom = (seed, candidate) => {
    // `null` means "not yet decided for this row" — distinct from the value `false`.
    const row = new Array(n).fill(null);
    row[seed.i] = seed.a;
    row[seed.j] = seed.b;
    const start = (candidate * 7 + 1) % n;
    for (let s = 0; s < n; s++) {
      const p = (start + s) % n;
      if (row[p] !== null) continue;
      let gainFalse = 0;
      let gainTrue = 0;
      for (let q = 0; q < n; q++) {
        if (q === p || row[q] === null) continue;
        if (!covered.has(pairId(p, false, q, row[q]))) gainFalse++;
        if (!covered.has(pairId(p, true, q, row[q]))) gainTrue++;
      }
      row[p] = gainTrue > gainFalse ? true
             : gainFalse > gainTrue ? false
             : tieBit(candidate, p);
    }
    return row;
  };

  /** How far a finished row is from an even split. Used only to break gain ties between candidates. */
  const imbalanceOf = (row) => Math.abs(row.filter(Boolean).length - n / 2);

  /** New combinations a finished row would contribute. */
  const gainOf = (row) => {
    const fresh = new Set();
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const id = pairId(i, row[i], j, row[j]);
        if (!covered.has(id)) fresh.add(id);
      }
    }
    return fresh.size;
  };

  while (covered.size < want && rows.length <= want) {
    const uncovered = listUncovered();
    if (!uncovered.length) break;

    // ⭐ WHY MORE THAN ONE CANDIDATE. Seeding every row from the FIRST still-uncovered pair biases the
    // whole matrix toward the keys that happen to sort early — measured at 45 keys, that cost roughly
    // twice the rows a spread of seeds needs, and each row of this matrix is a full smoke pass on a
    // live client. So a bounded, EVENLY SPACED set of seeds is grown out and the best-scoring finished
    // row wins. The spacing is arithmetic (stride over the uncovered list), not sampled, so the choice
    // is reproducible and the seeds are drawn from across the key range rather than its head. Each seed
    // is grown TWICE, under two different candidate indices — same seeded pair, different fill order and
    // different tie bits — so the sweep compares genuinely different rows rather than one row restated.
    const SEED_CAP = 32;
    const GROWTHS_PER_SEED = 2;
    const stride = Math.max(1, Math.ceil(uncovered.length / SEED_CAP));
    let bestRow = null;
    let bestGain = -1;
    let bestImbalance = Infinity;
    let candidate = 0;
    for (let s = 0; s < uncovered.length; s += stride) {
      for (let g = 0; g < GROWTHS_PER_SEED; g++) {
        const grown = growFrom(uncovered[s], candidate++);
        const gain = gainOf(grown);
        const imbalance = imbalanceOf(grown);
        // Most gain wins. Equal gain goes to the more balanced row — that is what stops the tail of the
        // matrix drifting into sparse rows once the easy pairs are gone. Equal on both keeps the earlier
        // candidate, so the choice stays a function of the key list alone.
        if (gain > bestGain || (gain === bestGain && imbalance < bestImbalance)) {
          bestGain = gain; bestImbalance = imbalance; bestRow = grown;
        }
      }
    }
    // Every seed pair was uncovered and survives into its own row, so the winner covers ≥ 1 new
    // combination — which is what makes this loop terminate rather than merely usually terminate.
    if (!bestRow || bestGain <= 0) break;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) covered.add(pairId(i, bestRow[i], j, bestRow[j]));
    }
    rows.push(Object.fromEntries(keys.map((k, idx) => [k, bestRow[idx]])));
  }

  return rows;
}

/**
 * VERIFY THE MATRIX — re-derived from the finished rows, sharing no logic with the builder above beyond
 * the pair-id spelling. This is what makes the guarantee assertable rather than assumed.
 * @returns {Array<{a: string, aValue: boolean, b: string, bValue: boolean}>} every combination missing
 */
export function uncoveredPairs(keys, rows) {
  const n = keys.length;
  const seen = new Set();
  for (const row of rows) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) seen.add(pairId(i, !!row[keys[i]], j, !!row[keys[j]]));
    }
  }
  const missing = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (const a of [false, true]) {
        for (const b of [false, true]) {
          if (!seen.has(pairId(i, a, j, b))) missing.push({ a: keys[i], aValue: a, b: keys[j], bValue: b });
        }
      }
    }
  }
  return missing;
}

/** Matrix shape at a glance: rows, the pair total it had to cover, and how many on-values per row. */
export function matrixReport(keys, rows) {
  return {
    keys: keys.length,
    rows: rows.length,
    pairsRequired: totalPairs(keys.length),
    uncovered: uncoveredPairs(keys, rows).length,
    onPerRow: rows.map(r => keys.filter(k => r[k] === true).length),
    exhaustiveWouldBe: keys.length <= 30 ? 2 ** keys.length : `2^${keys.length}`,
  };
}

/* ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
 * Run directly for a self-check that needs no rig and no browser: the coverage guarantee, the
 * determinism guarantee, and the exact-answer cases small enough to reason about by hand.
 */
const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("tools/pairwise-gen.mjs");
if (invokedDirectly) {
  const keysArg = process.argv.indexOf("--keys");
  const checks = [];
  const ok = (name, pass, detail = "") => {
    checks.push(!!pass);
    console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}${detail ? `   [${detail}]` : ""}`);
  };

  if (keysArg > 0) {
    const keys = String(process.argv[keysArg + 1] ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const rows = pairwiseBinary(keys);
    console.log(JSON.stringify({ report: matrixReport(keys, rows), rows }, null, 2));
    process.exit(0);
  }

  console.log("===== pairwise-gen self-check =====");
  /* ⛔ WHERE A UNIFORM ROW IS FORCED, STATED AS ARITHMETIC RATHER THAN ASSUMED. Every pair needs an
   * all-off witness and an all-on witness SOMEWHERE, but different pairs may use different rows — so a
   * mixed matrix is generally possible. It stops being possible at n=2, where "both keys off" has only
   * one row shape: the all-off world. (At n=3 mixed rows are possible but cost 6 rows against the
   * minimum 4 — 3 pairs × 4 combinations = 12 slots against 4 rows × 3 pairs, a perfect packing that no
   * set of mixed rows can achieve, since a mixed row of 3 keys contributes at most one same-value
   * combination. Below n=5 the matrix is small enough to read by eye and the row count matters more
   * than the shape, so mixedness is asserted from n=5 up, where it is both achievable and the point.) */
  const MIXED_FROM = 5;
  for (const n of [2, 3, 4, 5, 10, 20, 45, 60]) {
    const keys = Array.from({ length: n }, (_, i) => `k${i}`);
    const rows = pairwiseBinary(keys);
    const missing = uncoveredPairs(keys, rows);
    const onPerRow = rows.map(r => keys.filter(k => r[k]).length);
    ok(`n=${n}: every two-key combination appears in some row`, missing.length === 0,
      `${rows.length} row(s) for ${totalPairs(n)} combination(s)` + (missing.length ? ` — MISSING ${missing.length}` : ""));
    ok(`n=${n}: every row assigns a boolean to every key`,
      rows.every(r => keys.every(k => typeof r[k] === "boolean")), `${rows.length} row(s)`);
    const again = pairwiseBinary(keys);
    ok(`n=${n}: a second build of the same key list is byte-identical`,
      JSON.stringify(again) === JSON.stringify(rows));
    if (n >= MIXED_FROM) {
      // The property the settings suite's §2 leg asserts, checked here first so a regression is caught
      // without a browser: no row is all-off or all-on, and none turns a single switch on (or off) —
      // a row like that cannot contain a two-feature interaction, which is the only thing being hunted.
      const degenerate = onPerRow.filter(x => x === 0 || x === n).length;
      const nearlyDegenerate = onPerRow.filter(x => x === 1 || x === n - 1).length;
      ok(`n=${n}: no row is all-off, all-on, or a single switch away from either`,
        degenerate === 0 && nearlyDegenerate === 0,
        `on-per-row ${Math.min(...onPerRow)}–${Math.max(...onPerRow)} of ${n}`
        + (degenerate ? ` — ${degenerate} DEGENERATE` : "") + (nearlyDegenerate ? ` — ${nearlyDegenerate} SINGLE` : ""));
    }
  }

  // Two binary keys have exactly four combinations and no way to fold any of them together, so the
  // answer is known: four rows, and they are the four combinations. A generator that returns three has
  // a coverage hole by arithmetic. (The ORDER of those four is an artefact of the seed sweep and is
  // deliberately not asserted — the earlier "the first row is the all-off world" leg was asserting the
  // old constant tie rule, not a property of the matrix.)
  const two = pairwiseBinary(["a", "b"]);
  ok("n=2: the answer is the exhaustive four rows", two.length === 4, `${two.length}`);
  ok("n=2: those four rows are the four combinations, each exactly once",
    new Set(two.map(r => `${r.a ? 1 : 0}${r.b ? 1 : 0}`)).size === 4,
    JSON.stringify(two.map(r => `${r.a ? 1 : 0}${r.b ? 1 : 0}`)));

  // A matrix must be far smaller than the exhaustive product or it is not buying anything, and it must
  // stay small enough to RUN — every row of it is a full smoke pass on a live client. 45 binary settings
  // is 2^45 exhaustive worlds. The bound below is set just above what this construction actually
  // achieves (13 rows) rather than at the old runnability ceiling of 45: the constant-tie version passed
  // that ceiling at 31 rows while filling 18 of them with a single switch, so a loose bound is exactly
  // what failed to catch the defect. The information-theoretic floor for 45 binary factors is 9 rows
  // (Katona: k ≤ C(N-1, ⌈N/2⌉-1), and C(8,4) = 70 ≥ 45); greedy landing at 13 is accepted.
  const big = pairwiseBinary(Array.from({ length: 45 }, (_, i) => `k${i}`));
  ok("n=45: the matrix is close to the floor, not merely runnable (≤ 18 rows, vs 2^45 exhaustive)",
    big.length <= 18, `${big.length} rows`);

  // A deliberately broken matrix must be REPORTED as broken — the verifier is checked too.
  const keys5 = ["a", "b", "c", "d", "e"];
  const truncated = pairwiseBinary(keys5).slice(0, 2);
  ok("the verifier reports holes in a deliberately truncated matrix",
    uncoveredPairs(keys5, truncated).length > 0, `${uncoveredPairs(keys5, truncated).length} missing`);

  const passed = checks.filter(Boolean).length;
  console.log(`\n===== pairwise-gen: ${passed}/${checks.length} =====`);
  process.exit(passed === checks.length ? 0 : 1);
}
