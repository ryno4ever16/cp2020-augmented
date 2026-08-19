/**
 * PACK ID-STABILITY CHECK (:30004, official cyberpunk2020 1.1.1 + cp2020-augmented).
 *
 * WHY THIS EXISTS. The release recipe re-seeds the module's compiled packs from src/packs/ via
 * tools/pack.mjs (compilePack keys every LevelDB entry off the source file's own `_id`). Documents in
 * users' WORLDS reference pack documents by id — shop stock sourceKeys, corrections entries, npcgen
 * tables, cyberware install references — so a re-seed is only safe if the ids it writes are byte-for-byte
 * the ids the live packs already carry. This suite proves that equivalence BEFORE the re-seed step runs:
 *
 *   §1 source integrity   every src/packs JSON carries a well-formed 16-char `_id`, unique inside its
 *                         pack — the property compilePack needs to reproduce today's ids exactly
 *   §2 live ↔ src join    per module pack, the live compendium's id set and names equal the source's —
 *                         so "re-seed from src" is a no-op for identity, not a silent re-keying
 *   §3 negative control   the §2 comparator is fed a deliberately mutated copy of the source map and
 *                         must report exactly that one drift — the leg that proves the join can fail
 *   §4 code references    every 16-character quoted literal in module/*.js resolves in some live pack
 *                         index (base system or module) or is an enumerated non-id waiver — a broken
 *                         hardcoded reference fails here with its file:line
 *
 * Read-only. Run from tests/:
 *   FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-id-stability.mjs
 */
import { chromium } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src", "packs");
const MODULE_DIR = path.join(ROOT, "module");

/* Quoted 16-char strings in module JS that are NOT document ids. Exact literals only, same philosophy
 * as the data-conformance allowlist: everything else must resolve, and a stale waiver is prunable. */
const NON_ID_WAIVERS = new Set([
  "datafortress2020",   // a MODULE package name (shop/supplements.js), 16 chars with digits by coincidence
]);

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${pass || !detail ? "" : `\n        ${detail}`}`);
  if (!pass) failures++;
};

/* ── §1 source integrity ─────────────────────────────────────────────────────────────────────── */
const srcMap = {};            // pack -> { id -> name }
let files = 0, badId = [], dupes = [], nameMismatch = 0;
for (const pack of readdirSync(SRC)) {
  const dir = path.join(SRC, pack);
  if (!statSync(dir).isDirectory()) continue;
  srcMap[pack] = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    files++;
    const doc = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    const id = doc._id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9]{16}$/.test(id)) { badId.push(`${pack}/${f}`); continue; }
    if (srcMap[pack][id] !== undefined) dupes.push(`${pack}/${f} duplicates ${id}`);
    srcMap[pack][id] = String(doc.name ?? "");
    if (!f.endsWith(`_${id}.json`)) nameMismatch++;
  }
}
const srcPacks = Object.keys(srcMap);
ok(`§1 every source document carries a well-formed _id: ${files} files across ${srcPacks.length} packs`,
  files > 0 && badId.length === 0, badId.slice(0, 5).join(" · "));
ok("§1 no duplicate _id inside any pack", dupes.length === 0, dupes.slice(0, 5).join(" · "));
console.log(`INFO  filename/_id suffix disagreements (cosmetic, filenames are convention only): ${nameMismatch}`);

/* ── the §2 comparator, pure so §3 can attack it ─────────────────────────────────────────────── */
const joinDrift = (src, live) => {
  const out = [];
  for (const [id, name] of Object.entries(src)) {
    if (!(id in live)) out.push(`missing live ${id} "${name}"`);
    else if (live[id] !== name) out.push(`renamed ${id} "${name}" -> "${live[id]}"`);
  }
  for (const id of Object.keys(live)) if (!(id in src)) out.push(`extra live ${id} "${live[id]}"`);
  return out;
};

/* ── §4 literal harvest (node side, so file:line survives into the report) ──────────────────── */
const literals = [];          // { id, at }
let lettersOnlySkipped = 0;   // honesty counter for the digit heuristic below
const walkJs = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) { walkJs(p); continue; }
    if (!f.endsWith(".js")) continue;
    const lines = readFileSync(p, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/["'`]([a-zA-Z0-9]{16})["'`]/g)) {
        // Id shape = 16 alphanumerics WITH at least one digit. Letters-only 16-char literals are
        // overwhelmingly i18n keys and API names (RangefindingNote, MeasuredTemplate, …); a random
        // Foundry id is digit-free only ~(52/62)^16 ≈ 6 % of the time, so this trades a small,
        // COUNTED blind spot (INFO below) for zero word-key noise.
        if (!/[0-9]/.test(m[1])) { lettersOnlySkipped++; continue; }
        literals.push({ id: m[1], at: `${path.relative(ROOT, p)}:${i + 1}` });
      }
    });
  }
};
walkJs(MODULE_DIR);

/* ── live side ───────────────────────────────────────────────────────────────────────────────── */
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
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 20_000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await sel.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join as " + u.l);
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await joinAs(page, /^gamemaster$/i, [GM_PW]);

  const live = await page.evaluate(async () => {
    const modulePacks = {};   // short pack name -> { id -> name }
    const allIds = [];        // every document id in every pack, base system included
    for (const pack of game.packs) {
      const index = await pack.getIndex({ fields: ["name"] });
      const ids = index.map((e) => e._id);
      allIds.push(...ids);
      if (pack.metadata.packageName === "cp2020-augmented") {
        const short = pack.metadata.name;
        modulePacks[short] = Object.fromEntries(index.map((e) => [e._id, String(e.name ?? "")]));
      }
    }
    return { modulePacks, allIds, packCount: game.packs.size };
  });

  /* §2 — live ↔ src join, per pack */
  const liveShorts = Object.keys(live.modulePacks);
  ok(`§2 pack roster: every src pack is live and every live module pack has source (${srcPacks.length} src / ${liveShorts.length} live)`,
    srcPacks.length === liveShorts.length && srcPacks.every((p) => liveShorts.includes(p)),
    `src-only: ${srcPacks.filter((p) => !liveShorts.includes(p)).join(",")} · live-only: ${liveShorts.filter((p) => !srcPacks.includes(p)).join(",")}`);
  let driftTotal = 0;
  for (const pack of srcPacks) {
    const drift = joinDrift(srcMap[pack], live.modulePacks[pack] ?? {});
    driftTotal += drift.length;
    ok(`§2 ${pack}: live ids and names equal source (${Object.keys(srcMap[pack]).length} docs)`,
      drift.length === 0, drift.slice(0, 4).join(" · ") + (drift.length > 4 ? ` · +${drift.length - 4} more` : ""));
  }

  /* §3 — negative control: the comparator must see a planted drift */
  const firstPack = srcPacks[0];
  const mutated = { ...srcMap[firstPack] };
  const victim = Object.keys(mutated)[0];
  delete Object.assign(mutated, { ["XXXXXXXXXXXXXXX0"]: mutated[victim] })[victim];
  const planted = joinDrift(mutated, live.modulePacks[firstPack] ?? {});
  ok("§3 negative control: a re-keyed source id is reported as exactly one missing + one extra",
    planted.length === 2 && planted.some((d) => d.startsWith("missing")) && planted.some((d) => d.startsWith("extra")),
    JSON.stringify(planted));

  /* §4 — every id-shaped literal in module code resolves somewhere live */
  const liveIdSet = new Set(live.allIds);
  const unresolved = literals.filter((l) => !liveIdSet.has(l.id) && !NON_ID_WAIVERS.has(l.id));
  const uniqueRefs = new Set(literals.map((l) => l.id));
  ok(`§4 code references: ${literals.length} id-shaped literals (${uniqueRefs.size} distinct) across module/ all resolve in a live pack index`,
    unresolved.length === 0,
    unresolved.slice(0, 10).map((l) => `${l.id} @ ${l.at}`).join(" · ") + (unresolved.length > 10 ? ` · +${unresolved.length - 10} more` : ""));

  ok(`0 console errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  console.log(`INFO  scope: ${live.packCount} live packs · ${files} src docs · drift ${driftTotal}`);
} finally {
  await browser.close();
}
console.log(`RESULT: ${failures === 0 ? "PASS" : "FAIL"} (${failures} failing)`);
process.exit(failures === 0 ? 0 : 1);
